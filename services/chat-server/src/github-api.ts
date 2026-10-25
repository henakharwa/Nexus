// Small GitHub REST helpers used by the team features: account login,
// repository access, open issues (duplicate checks) and repository
// webhooks. Injectable through CreateServerDeps.githubTeamApi so tests never
// reach github.com.
import { createHash } from "node:crypto";

export type RepoAccess = "write" | "read" | "none" | "unknown";

export interface GithubTeamApi {
  /** The GitHub username behind a token. */
  getLogin(token: string): Promise<string | null>;
  /** What the token's account can do on a repository. "unknown" when GitHub could not be asked. */
  getRepoAccess(token: string, owner: string, repo: string): Promise<RepoAccess>;
  listOpenIssues(token: string, owner: string, repo: string): Promise<Array<{ number: number; title: string; url: string }>>;
  createRepoWebhook(token: string, owner: string, repo: string, input: { url: string; secret: string; events: string[] }): Promise<{ id: number }>;
  // Used by approval rules to know which branch an action lands on and what
  // GitHub itself will require there. Optional: when missing, or when GitHub
  // can't be asked, the branch counts as unknown (see approval-rules.ts).
  /** The branch a pull request merges into. */
  getPullRequestBase?(token: string, owner: string, repo: string, number: number): Promise<string | null>;
  /** The repository's default branch. */
  getDefaultBranch?(token: string, owner: string, repo: string): Promise<string | null>;
  /** Whether GitHub protects a branch, and how many approving reviews its rules require (null when not visible to this token). */
  getBranchProtection?(token: string, owner: string, repo: string, branch: string): Promise<{ protected: boolean; requiredReviews: number | null } | null>;
  // Used to show approvers exactly what an action will change
  // (change-preview.ts). Null means GitHub couldn't be asked.
  /** A file's current text, or { exists: false } when there's no such file. */
  getFileText?(token: string, owner: string, repo: string, path: string, ref: string | null): Promise<{ exists: true; text: string } | { exists: false } | null>;
  getPullRequest?(token: string, owner: string, repo: string, number: number): Promise<{ title: string; body: string; head: string; base: string; state: string } | null>;
  /** Files a pull request changes, or that differ between two branches when `base`/`head` are given. */
  listChangedFiles?(token: string, owner: string, repo: string, which: { pullNumber: number } | { base: string; head: string }): Promise<GithubChangedFile[] | null>;
  getIssue?(token: string, owner: string, repo: string, number: number): Promise<{ title: string; body: string; state: string; labels: string[] } | null>;
}

export interface GithubChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  // Unified diff; missing for binary or very large files.
  patch: string | null;
}

const API = "https://api.github.com";

/** An API that never calls GitHub: access is "unknown" and there is no login. Used when none is injected (tests). */
export const offlineGithubTeamApi: GithubTeamApi = {
  getLogin: async () => null,
  getRepoAccess: async () => "unknown",
  listOpenIssues: async () => [],
  createRepoWebhook: async () => {
    throw new Error("GitHub is not reachable from this server.");
  },
};

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

async function githubRequest(path: string, init: RequestInit & { token?: string; timeoutMs?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "nexus-multiplayer-ai",
    ...(init.body ? { "content-type": "application/json" } : {}),
  };
  if (init.token) headers.authorization = `token ${init.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    return await fetchImpl(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: string; errors?: Array<{ message?: string }> };
  const detail = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
  return [body.message, detail].filter(Boolean).join(": ") || `GitHub returned ${response.status}`;
}

export function createGithubTeamApi(fetchImpl: typeof fetch = fetch): GithubTeamApi {
  const accessCache = new Map<string, { value: RepoAccess; expiresAt: number }>();
  const loginCache = new Map<string, { value: string | null; expiresAt: number }>();
  const ACCESS_TTL_MS = 10 * 60_000;

  return {
    async getLogin(token) {
      const key = tokenFingerprint(token);
      const cached = loginCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      try {
        const response = await githubRequest("/user", { token }, fetchImpl);
        const login = response.ok ? (((await response.json()) as { login?: string }).login ?? null) : null;
        loginCache.set(key, { value: login, expiresAt: Date.now() + 60 * 60_000 });
        return login;
      } catch {
        return null;
      }
    },
    async getRepoAccess(token, owner, repo) {
      const key = `${tokenFingerprint(token)}:${owner}/${repo}`.toLowerCase();
      const cached = accessCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      let value: RepoAccess;
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token }, fetchImpl);
        if (response.status === 404 || response.status === 403) value = "none";
        else if (!response.ok) value = "unknown";
        else {
          const permissions = ((await response.json()) as { permissions?: { push?: boolean; admin?: boolean; maintain?: boolean; pull?: boolean } }).permissions;
          value = !permissions ? "unknown" : permissions.push || permissions.admin || permissions.maintain ? "write" : permissions.pull ? "read" : "none";
        }
      } catch {
        value = "unknown";
      }
      // Do not remember transient failures for long.
      accessCache.set(key, { value, expiresAt: Date.now() + (value === "unknown" ? 30_000 : ACCESS_TTL_MS) });
      return value;
    },
    async listOpenIssues(token, owner, repo) {
      const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100`, { token, timeoutMs: 5000 }, fetchImpl);
      if (!response.ok) return [];
      const issues = (await response.json()) as Array<{ number: number; title: string; html_url: string; pull_request?: unknown }>;
      return issues.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url }));
    },
    async getPullRequestBase(token, owner, repo, number) {
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, { token, timeoutMs: 5000 }, fetchImpl);
        if (!response.ok) return null;
        return ((await response.json()) as { base?: { ref?: string } }).base?.ref ?? null;
      } catch {
        return null;
      }
    },
    async getDefaultBranch(token, owner, repo) {
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token, timeoutMs: 5000 }, fetchImpl);
        if (!response.ok) return null;
        return ((await response.json()) as { default_branch?: string }).default_branch ?? null;
      } catch {
        return null;
      }
    },
    async getBranchProtection(token, owner, repo, branch) {
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      try {
        // "protected" is visible to anyone who can read the repository.
        const branchResponse = await githubRequest(`${base}/branches/${encodeURIComponent(branch)}`, { token, timeoutMs: 5000 }, fetchImpl);
        if (!branchResponse.ok) return null;
        const isProtected = Boolean(((await branchResponse.json()) as { protected?: boolean }).protected);
        // Repository rulesets that apply to the branch are readable with read access.
        let requiredReviews: number | null = null;
        const rulesResponse = await githubRequest(`${base}/rules/branches/${encodeURIComponent(branch)}`, { token, timeoutMs: 5000 }, fetchImpl);
        if (rulesResponse.ok) {
          const rules = (await rulesResponse.json()) as Array<{ type?: string; parameters?: { required_approving_review_count?: number } }>;
          for (const rule of rules) {
            if (rule.type === "pull_request" && typeof rule.parameters?.required_approving_review_count === "number") {
              requiredReviews = Math.max(requiredReviews ?? 0, rule.parameters.required_approving_review_count);
            }
          }
        }
        // Classic branch protection details need admin access; use them when visible.
        if (isProtected) {
          const reviewsResponse = await githubRequest(`${base}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews`, { token, timeoutMs: 5000 }, fetchImpl);
          if (reviewsResponse.ok) {
            const count = ((await reviewsResponse.json()) as { required_approving_review_count?: number }).required_approving_review_count;
            if (typeof count === "number") requiredReviews = Math.max(requiredReviews ?? 0, count);
          }
        }
        return { protected: isProtected || requiredReviews !== null, requiredReviews };
      } catch {
        return null;
      }
    },
    async getFileText(token, owner, repo, path, ref) {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${query}`, { token, timeoutMs: 8000, headers: { accept: "application/vnd.github.raw+json" } }, fetchImpl);
        if (response.status === 404) return { exists: false };
        if (!response.ok) return null;
        return { exists: true, text: await response.text() };
      } catch {
        return null;
      }
    },
    async getPullRequest(token, owner, repo, number) {
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, { token, timeoutMs: 5000 }, fetchImpl);
        if (!response.ok) return null;
        const pull = (await response.json()) as { title?: string; body?: string | null; state?: string; head?: { ref?: string }; base?: { ref?: string } };
        return { title: pull.title ?? "", body: pull.body ?? "", head: pull.head?.ref ?? "", base: pull.base?.ref ?? "", state: pull.state ?? "" };
      } catch {
        return null;
      }
    },
    async listChangedFiles(token, owner, repo, which) {
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const path = "pullNumber" in which ? `${base}/pulls/${which.pullNumber}/files?per_page=100` : `${base}/compare/${encodeURIComponent(which.base)}...${encodeURIComponent(which.head)}`;
      try {
        const response = await githubRequest(path, { token, timeoutMs: 8000 }, fetchImpl);
        if (!response.ok) return null;
        const body = (await response.json()) as unknown;
        const files = (Array.isArray(body) ? body : ((body as { files?: unknown[] }).files ?? [])) as Array<{ filename?: string; status?: string; additions?: number; deletions?: number; patch?: string }>;
        return files.map((file) => ({ filename: file.filename ?? "", status: file.status ?? "modified", additions: file.additions ?? 0, deletions: file.deletions ?? 0, patch: file.patch ?? null }));
      } catch {
        return null;
      }
    },
    async getIssue(token, owner, repo, number) {
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, { token, timeoutMs: 5000 }, fetchImpl);
        if (!response.ok) return null;
        const issue = (await response.json()) as { title?: string; body?: string | null; state?: string; labels?: Array<string | { name?: string }> };
        return { title: issue.title ?? "", body: issue.body ?? "", state: issue.state ?? "", labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean) };
      } catch {
        return null;
      }
    },
    async createRepoWebhook(token, owner, repo, input) {
      const response = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
        { method: "POST", token, body: JSON.stringify({ name: "web", active: true, events: input.events, config: { url: input.url, content_type: "json", secret: input.secret, insecure_ssl: "0" } }) },
        fetchImpl
      );
      if (response.status === 401) {
        throw new Error("GitHub no longer accepts your saved GitHub connection (it was revoked or expired). Disconnect GitHub, connect it again, then try again.");
      }
      if (response.status === 404 || response.status === 403) {
        throw new Error(`Your GitHub account needs admin access to ${owner}/${repo} to add a webhook. Ask a repository admin to add it with the URL and secret shown here.`);
      }
      if (!response.ok) {
        const message = await errorText(response);
        if (/already exists/i.test(message)) throw new Error(`A webhook with this URL already exists on ${owner}/${repo}. Update its secret to the one shown here, or delete it and try again.`);
        throw new Error(`GitHub refused the webhook: ${message}`);
      }
      return { id: Number(((await response.json()) as { id: number }).id) };
    },
  };
}
