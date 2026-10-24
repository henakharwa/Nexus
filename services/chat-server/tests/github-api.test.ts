import { describe, expect, it } from "vitest";
import { createGithubTeamApi } from "../src/github-api.js";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const path = String(url).replace("https://api.github.com", "");
    const route = routes[`${init.method ?? "GET"} ${path}`] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("github-api", () => {
  it("maps repository permissions to write, read or none, and caches the answer", async () => {
    const { impl, calls } = fakeFetch({
      "GET /repos/acme/web": { body: { permissions: { pull: true, push: true } } },
      "GET /repos/acme/docs": { body: { permissions: { pull: true, push: false } } },
      "GET /repos/acme/odd": { body: {} },
    });
    const api = createGithubTeamApi(impl);
    expect(await api.getRepoAccess("t", "acme", "web")).toBe("write");
    expect(await api.getRepoAccess("t", "acme", "docs")).toBe("read");
    expect(await api.getRepoAccess("t", "acme", "secret")).toBe("none");
    // No permissions in the reply: don't guess.
    expect(await api.getRepoAccess("t", "acme", "odd")).toBe("unknown");
    expect(await api.getRepoAccess("t", "acme", "web")).toBe("write");
    expect(calls.filter((call) => call.url.endsWith("/repos/acme/web"))).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("token t");
  });

  it("explains webhook permission problems", async () => {
    const { impl } = fakeFetch({ "POST /repos/acme/web/hooks": { status: 404, body: { message: "Not Found" } } });
    const api = createGithubTeamApi(impl);
    await expect(api.createRepoWebhook("t", "acme", "web", { url: "https://x", secret: "s", events: ["issues"] })).rejects.toThrow(/needs admin access to acme\/web/);
  });

  it("asks the member to reconnect when GitHub rejects the saved token", async () => {
    const { impl } = fakeFetch({ "POST /repos/acme/web/hooks": { status: 401, body: { message: "Bad credentials" } } });
    const api = createGithubTeamApi(impl);
    await expect(api.createRepoWebhook("t", "acme", "web", { url: "https://x", secret: "s", events: ["issues"] })).rejects.toThrow(/Disconnect GitHub, connect it again/);
  });

  it("reads a pull request's base branch and the default branch, for approval rules", async () => {
    const { impl } = fakeFetch({
      "GET /repos/acme/web/pulls/7": { body: { base: { ref: "release/2.4" } } },
      "GET /repos/acme/web": { body: { default_branch: "main", permissions: { push: true } } },
    });
    const api = createGithubTeamApi(impl);
    expect(await api.getPullRequestBase!("t", "acme", "web", 7)).toBe("release/2.4");
    expect(await api.getPullRequestBase!("t", "acme", "web", 8)).toBeNull();
    expect(await api.getDefaultBranch!("t", "acme", "web")).toBe("main");
  });

  it("combines rulesets and visible classic protection into the reviews GitHub requires", async () => {
    const { impl } = fakeFetch({
      "GET /repos/acme/web/branches/main": { body: { name: "main", protected: true } },
      "GET /repos/acme/web/rules/branches/main": { body: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }] },
      "GET /repos/acme/web/branches/main/protection/required_pull_request_reviews": { body: { required_approving_review_count: 2 } },
      "GET /repos/acme/web/branches/dev": { body: { name: "dev", protected: false } },
      "GET /repos/acme/web/rules/branches/dev": { body: [] },
    });
    const api = createGithubTeamApi(impl);
    expect(await api.getBranchProtection!("t", "acme", "web", "main")).toEqual({ protected: true, requiredReviews: 2 });
    expect(await api.getBranchProtection!("t", "acme", "web", "dev")).toEqual({ protected: false, requiredReviews: null });
    // A branch GitHub won't show: unknown, not "unprotected".
    expect(await api.getBranchProtection!("t", "acme", "web", "ghost")).toBeNull();
  });

  it("still reports protection when classic protection details need admin access", async () => {
    const { impl } = fakeFetch({
      "GET /repos/acme/web/branches/main": { body: { name: "main", protected: true } },
      "GET /repos/acme/web/rules/branches/main": { body: [] },
    });
    const api = createGithubTeamApi(impl);
    expect(await api.getBranchProtection!("t", "acme", "web", "main")).toEqual({ protected: true, requiredReviews: null });
  });
});
