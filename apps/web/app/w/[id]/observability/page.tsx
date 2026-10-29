"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  AuditEvent,
  IntegrationConfig,
  WorkflowRun,
  WorkspaceTokenBudget,
  WorkspaceWorkflow,
} from "@mai-chat/shared-types";
import { AccessNotice } from "../../../_components/AccessNotice";
import { useWorkspaceAccess } from "../../../../lib/useWorkspaceAccess";
import {
  describeError,
  getObservabilityRetentionPolicy,
  getWorkspaceTokenBudget,
  listAuditEvents,
  listIntegrations,
  listWorkspaceWorkflowRuns,
  listWorkspaceWorkflows,
  updateFailureAlertThreshold,
  updateObservabilityRetentionPolicy,
  updateWorkspaceTokenBudget,
} from "../../../../lib/api";

type RunWithWorkflow = WorkflowRun & { workflowName: string };
const providers = ["github", "slack", "linear", "notion", "figma"] as const;

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function duration(run: WorkflowRun) {
  if (!run.completedAt) return "Running";
  const seconds = Math.max(
    0,
    Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function compactTokens(value: number) {
  return value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0))}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : String(value);
}
function bucketLabel(value: number, range: "24h" | "7d" | "30d" | "all") {
  return range === "24h"
    ? new Date(value).toLocaleTimeString([], { hour: "numeric" })
    : new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function ObservabilityPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [workflows, setWorkflows] = useState<WorkspaceWorkflow[]>([]);
  const [runs, setRuns] = useState<RunWithWorkflow[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [selectedRun, setSelectedRun] = useState<RunWithWorkflow | null>(null);
  const [compareRunId, setCompareRunId] = useState("");
  const [failureThreshold, setFailureThreshold] = useState(3);
  const [perTurnTokenLimit, setPerTurnTokenLimit] = useState<number | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [retentionNotice, setRetentionNotice] = useState("");
  const [tokenBudget, setTokenBudget] = useState<WorkspaceTokenBudget | null>(null);
  const [budgetNotice, setBudgetNotice] = useState("");
  // Viewing observability is shared; retention and alert thresholds are Admin only.
  const access = useWorkspaceAccess(workspaceId);
  const canControl = access.isAdmin;

  // Loaded on its own so a budget error never hides the rest of the page.
  useEffect(() => {
    let cancelled = false;
    getWorkspaceTokenBudget(workspaceId)
      .then((budget) => {
        if (!cancelled) setTokenBudget(budget);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  async function saveTokenBudget(value: number | null) {
    setBudgetNotice("");
    try {
      setTokenBudget(await updateWorkspaceTokenBudget(workspaceId, value));
      setBudgetNotice("Daily AI budget saved.");
    } catch (reason) {
      setBudgetNotice(describeError(reason, "Could not save the daily AI budget."));
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listWorkspaceWorkflows(workspaceId),
      listAuditEvents(workspaceId, { limit: 200 }),
      listIntegrations(workspaceId),
      getObservabilityRetentionPolicy(workspaceId),
      listWorkspaceWorkflowRuns(workspaceId),
    ])
      .then(([workflowList, audit, integrationList, retention, runList]) => {
        // One request for every workflow's recent runs (previously one request per workflow).
        if (!cancelled) {
          setWorkflows(workflowList);
          setRuns(runList);
          setEvents(audit.events);
          setIntegrations(integrationList);
          setRetentionDays(retention.retentionDays);
          setFailureThreshold(retention.failureAlertThreshold);
          setPerTurnTokenLimit(retention.perTurnTokenLimit ?? null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(describeError(reason, "Could not load observability data."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // The failure-alert threshold is a workspace setting saved by Admins and used by server alert delivery.
  async function saveControls(next: { failureThreshold?: number }) {
    if (next.failureThreshold === undefined) return;
    try {
      const policy = await updateFailureAlertThreshold(workspaceId, next.failureThreshold);
      setFailureThreshold(policy.failureAlertThreshold);
      setRetentionNotice("Failure-alert threshold saved.");
    } catch (reason) {
      setRetentionNotice(describeError(reason, "Could not save the failure-alert threshold."));
    }
  }
  async function saveRetention(value: 7 | 30 | 90 | 365) {
    try {
      const policy = await updateObservabilityRetentionPolicy(workspaceId, value);
      setRetentionDays(policy.retentionDays);
      setRetentionNotice(
        policy.removed
          ? `Removed ${policy.removed} expired workflow run${policy.removed === 1 ? "" : "s"}.`
          : "Retention policy saved; expired runs are removed daily.",
      );
    } catch (reason) {
      setRetentionNotice(describeError(reason, "Could not save retention policy."));
    }
  }
  const filtered = useMemo(() => {
    const hours = range === "24h" ? 24 : range === "7d" ? 168 : range === "30d" ? 720 : Infinity;
    const cutoff = Date.now() - hours * 3600000;
    return {
      runs: runs.filter((run) => new Date(run.startedAt).getTime() >= cutoff),
      events: events.filter((event) => new Date(event.createdAt).getTime() >= cutoff),
    };
  }, [events, range, runs]);
  const metrics = useMemo(() => {
    const completed = filtered.runs.filter((run) => run.status !== "running");
    const succeeded = completed.filter((run) => run.status === "succeeded");
    const failed = completed.filter((run) => run.status === "failed");
    const elapsed = completed
      .filter((run) => run.completedAt)
      .map((run) => new Date(run.completedAt!).getTime() - new Date(run.startedAt).getTime());
    const averageSeconds = elapsed.length
      ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length / 1000)
      : null;
    const toolEvents = filtered.events.filter(
      (event) => event.eventType.startsWith("action.") || event.eventType === "integration.connected",
    );
    const estimatedTokens = filtered.runs.reduce((total, run) => total + run.estimatedTokens, 0);
    const estimatedCostUsd = filtered.runs.reduce((total, run) => total + run.estimatedCostUsd, 0);
    const runsWithProviderUsage = filtered.runs.filter(
      (run) => run.providerPromptTokens !== null || run.providerCompletionTokens !== null,
    );
    const providerTokens = runsWithProviderUsage.reduce(
      (total, run) => total + (run.providerPromptTokens ?? 0) + (run.providerCompletionTokens ?? 0),
      0,
    );
    const providerCosts = filtered.runs.filter((run) => run.providerCostUsd !== null);
    const providerCostUsd = providerCosts.reduce((total, run) => total + (run.providerCostUsd ?? 0), 0);
    return {
      completed,
      succeeded,
      failed,
      averageSeconds,
      toolEvents,
      estimatedTokens,
      estimatedCostUsd,
      providerTokens,
      runsWithProviderUsage: runsWithProviderUsage.length,
      providerCostUsd,
      runsWithProviderCost: providerCosts.length,
    };
  }, [filtered]);
  const errors = useMemo(
    () =>
      [
        ...metrics.failed.map((run) => run.detail || "Workflow execution failed"),
        ...filtered.events.filter((event) => event.eventType.endsWith("failed")).map((event) => event.summary),
      ].reduce<Record<string, number>>((all, item) => {
        all[item] = (all[item] ?? 0) + 1;
        return all;
      }, {}),
    [filtered.events, metrics.failed],
  );
  const trend = useMemo(() => {
    const bucketHours = range === "24h" ? 4 : range === "7d" ? 24 : range === "30d" ? 24 * 5 : 24 * 7;
    const count = range === "24h" ? 6 : range === "7d" ? 7 : range === "30d" ? 6 : 8;
    const start = Date.now() - bucketHours * count * 3600000;
    return Array.from({ length: count }, (_, index) => {
      const from = start + index * bucketHours * 3600000;
      const to = from + bucketHours * 3600000;
      const inBucket = filtered.runs.filter((run) => {
        const time = new Date(run.startedAt).getTime();
        return time >= from && time < to;
      });
      return {
        label: bucketLabel(from, range),
        runs: inBucket.length,
        failures: inBucket.filter((run) => run.status === "failed").length,
        tools: inBucket.reduce((total, run) => total + run.toolCalls, 0),
      };
    });
  }, [filtered.runs, range]);
  const integrationDiagnostics = useMemo(
    () =>
      providers.map((provider) => {
        const integration = integrations.find((item) => item.type === provider);
        const workflowFailures = filtered.runs.filter(
          (run) =>
            run.status === "failed" &&
            workflows.find((workflow) => workflow.id === run.workflowId)?.agentKind === provider,
        ).length;
        return { provider, integration, workflowFailures };
      }),
    [filtered.runs, integrations, workflows],
  );
  const comparison = runs.find((run) => run.id === compareRunId) ?? null;
  function exportIncident() {
    const lines = [
      "Operational incident report",
      `Range,${range}`,
      `Runs,${metrics.completed.length}`,
      `Failures,${metrics.failed.length}`,
      `Average latency,${metrics.averageSeconds ?? "n/a"}s`,
      "",
      "Errors",
      ...Object.entries(errors).map(([message, count]) => `${count},\"${message.replaceAll('"', '""')}\"`),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "workspace-incident-report.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="observability-page">
      <header className="observability-header">
        <div>
          <p className="eyebrow">OBSERVABILITY</p>
          <h1>Operations console</h1>
          <span>
            Monitor runs, governed tool activity, source health, latency, errors, and the workspace budget guard.
          </span>
        </div>
        <div className="observability-actions">
          <select
            value={range}
            onChange={(event) => setRange(event.target.value as typeof range)}
            aria-label="Observability time range"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
          <button className="secondary-button" onClick={exportIncident}>
            Export incident
          </button>
          <Link className="secondary-button" href={`/w/${workspaceId}/audit`}>
            Open activity log
          </Link>
        </div>
      </header>
      {error && <p className="error-text">{error}</p>}
      <section className="observability-metrics" aria-label="Operational health">
        <article>
          <span>Run success</span>
          <strong>
            {metrics.completed.length
              ? `${Math.round((metrics.succeeded.length / metrics.completed.length) * 100)}%`
              : "—"}
          </strong>
          <small>
            {metrics.succeeded.length} succeeded · {metrics.failed.length} failed
          </small>
        </article>
        <article>
          <span>Average latency</span>
          <strong>{metrics.averageSeconds === null ? "—" : `${metrics.averageSeconds}s`}</strong>
          <small>completed workflow runs</small>
        </article>
        <article>
          <span>Tool activity</span>
          <strong>{filtered.runs.reduce((total, run) => total + run.toolCalls, 0)}</strong>
          <small>recorded workflow tool calls</small>
        </article>
        <article>
          <span>Provider usage</span>
          <strong>{metrics.providerTokens.toLocaleString()}</strong>
          <small>
            {metrics.runsWithProviderUsage
              ? `reported tokens from ${metrics.runsWithProviderUsage} run${metrics.runsWithProviderUsage === 1 ? "" : "s"}`
              : "Provider did not report usage for these runs"}
          </small>
          <small>
            {metrics.runsWithProviderCost
              ? `$${metrics.providerCostUsd.toFixed(4)} reported provider cost`
              : `$${metrics.estimatedCostUsd.toFixed(4)} calculated cost estimate`}
          </small>
        </article>
      </section>
      <div className="observability-grid">
        <section className="observability-card observability-runs">
          <header>
            <div>
              <p>Run timelines</p>
              <h2>Recent workflow executions</h2>
            </div>
            <Link href={`/w/${workspaceId}/workflows`}>Manage workflows</Link>
          </header>
          {loading ? (
            <p>Loading run history…</p>
          ) : filtered.runs.length ? (
            <div className="run-timeline">
              {filtered.runs.slice(0, 12).map((run) => (
                <button type="button" key={run.id} onClick={() => setSelectedRun(run)}>
                  <span className={`run-dot ${run.status}`} />
                  <div>
                    <strong>{run.workflowName}</strong>
                    <small>
                      {run.trigger.replaceAll("_", " ")} · {relativeTime(run.startedAt)}
                    </small>
                    {run.detail && <em>{run.detail}</em>}
                  </div>
                  <b>{duration(run)}</b>
                </button>
              ))}
            </div>
          ) : (
            <div className="observability-empty">No workflow runs in this time range.</div>
          )}
        </section>
        <section className="observability-card observability-traces">
          <header>
            <div>
              <p>Tool call tracing</p>
              <h2>Governed tool activity</h2>
            </div>
            <Link href={`/w/${workspaceId}/audit?type=action.proposed`}>View all</Link>
          </header>
          {metrics.toolEvents.length ? (
            <div className="trace-list">
              {metrics.toolEvents.slice(0, 8).map((event) => (
                <article key={event.id}>
                  <span
                    className={`trace-state ${event.eventType.endsWith("failed") ? "failed" : event.eventType.endsWith("confirmed") ? "success" : "neutral"}`}
                  />
                  <div>
                    <strong>{event.eventType.replaceAll(".", " ")}</strong>
                    <small>{event.summary}</small>
                  </div>
                  <time>{relativeTime(event.createdAt)}</time>
                </article>
              ))}
            </div>
          ) : (
            <div className="observability-empty">No governed tool calls have been recorded.</div>
          )}
        </section>
        <section className="observability-card observability-health">
          <header>
            <div>
              <p>Integration diagnostics</p>
              <h2>Source availability and failures</h2>
            </div>
            <Link href={`/w/${workspaceId}/integrations`}>Manage sources</Link>
          </header>
          <div className="source-health">
            {integrationDiagnostics.map(({ provider, integration, workflowFailures }) => (
              <div key={provider}>
                <span className={integration ? "healthy" : "offline"} />
                <strong>{provider}</strong>
                <small>
                  {integration
                    ? `${integration.connectionName ?? ("accountName" in integration ? integration.accountName : undefined) ?? "Connected"} · ${relativeTime(integration.connectedAt)}`
                    : "Not connected"}
                </small>
                {workflowFailures > 0 && (
                  <em>
                    {workflowFailures} failed run{workflowFailures === 1 ? "" : "s"} in this range
                  </em>
                )}
                {!integration && <Link href={`/w/${workspaceId}/integrations`}>Connect source</Link>}
              </div>
            ))}
          </div>
        </section>
        <section className="observability-card observability-budget">
          <header>
            <div>
              <p>Budgets and errors</p>
              <h2>Runtime guardrails</h2>
            </div>
          </header>
          <div className="budget-list">
            {tokenBudget && (
              <div className={`daily-token-budget ${tokenBudget.exhausted ? "exhausted" : ""}`}>
                <span>Daily AI token budget</span>
                <strong>
                  {tokenBudget.usedToday.toLocaleString()} / {tokenBudget.dailyLimit.toLocaleString()} tokens
                </strong>
                <div
                  className="token-budget-meter"
                  role="meter"
                  aria-label="Daily AI token budget used"
                  aria-valuemin={0}
                  aria-valuemax={tokenBudget.dailyLimit}
                  aria-valuenow={Math.min(tokenBudget.usedToday, tokenBudget.dailyLimit)}
                >
                  <i style={{ width: `${Math.min(100, (tokenBudget.usedToday / tokenBudget.dailyLimit) * 100)}%` }} />
                </div>
                <small>
                  {tokenBudget.exhausted
                    ? "Used up: new agent replies, workflow runs and AI drafts wait until the reset."
                    : `${tokenBudget.remaining.toLocaleString()} left today across ${tokenBudget.agentTurnsToday} agent turn${tokenBudget.agentTurnsToday === 1 ? "" : "s"}.`}{" "}
                  Resets at midnight UTC (
                  {new Date(tokenBudget.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} your
                  time).
                </small>
                {tokenBudget.recentDays.length > 1 && (
                  <ol className="token-budget-days" aria-label="Tokens used in the last 7 days">
                    {tokenBudget.recentDays.map((day) => (
                      <li key={day.date} title={`${day.date}: ${day.tokens.toLocaleString()} tokens`}>
                        <i
                          style={{
                            height: `${Math.max(4, Math.min(100, (day.tokens / tokenBudget.dailyLimit) * 100))}%`,
                          }}
                        />
                        <em>{new Date(`${day.date}T12:00:00Z`).toLocaleDateString([], { weekday: "narrow" })}</em>
                      </li>
                    ))}
                  </ol>
                )}
                <label className="observability-control">
                  Daily limit
                  <select
                    value={tokenBudget.isCustom ? String(tokenBudget.dailyLimit) : "default"}
                    disabled={!canControl}
                    onChange={(event) =>
                      void saveTokenBudget(event.target.value === "default" ? null : Number(event.target.value))
                    }
                  >
                    <option value="default">Server default ({compactTokens(tokenBudget.defaultLimit)})</option>
                    {tokenBudget.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {compactTokens(choice)} tokens
                      </option>
                    ))}
                  </select>
                </label>
                {budgetNotice && <small role="status">{budgetNotice}</small>}
              </div>
            )}
            <div>
              <span>Per-turn token guard</span>
              <strong>{perTurnTokenLimit === null ? "—" : `${perTurnTokenLimit.toLocaleString()} tokens`}</strong>
              <small>Configured server guard; protects a turn from exhausting the provider rate limit.</small>
            </div>
            <div>
              <span>Failed workflow runs</span>
              <strong>{metrics.failed.length}</strong>
              <small>
                {metrics.failed.length
                  ? "Review failures in the run timeline or Activity."
                  : "No failed completed runs recorded."}
              </small>
            </div>
            <div>
              <span>Enabled workflows</span>
              <strong>{workflows.filter((workflow) => workflow.enabled).length}</strong>
              <small>{workflows.length} total workflows are configured in this workspace.</small>
            </div>
          </div>
        </section>
        <section className="observability-card">
          <header>
            <div>
              <p>Error grouping</p>
              <h2>Root causes in this range</h2>
            </div>
          </header>
          <div className="error-groups">
            {Object.keys(errors).length ? (
              Object.entries(errors)
                .slice(0, 5)
                .map(([message, count]) => (
                  <div key={message}>
                    <b>{count}</b>
                    <span>{message}</span>
                  </div>
                ))
            ) : (
              <p className="observability-empty">No errors recorded in this range.</p>
            )}
          </div>
        </section>
        <section className="observability-card">
          <header>
            <div>
              <p>Alert delivery</p>
              <h2>Escalate repeated failures</h2>
            </div>
          </header>
          <p className="observability-empty">
            Workspace members receive an in-app alert when workflow failures cross {failureThreshold} in 24 hours.
          </p>
          <label className="observability-control">
            Alert threshold
            <select
              value={failureThreshold}
              disabled={!canControl}
              onChange={(event) => void saveControls({ failureThreshold: Number(event.target.value) })}
            >
              {[...new Set([1, 3, 5, failureThreshold])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value} failed run{value === 1 ? "" : "s"}
                  </option>
                ))}
            </select>
          </label>
          <AccessNotice
            workspaceId={workspaceId}
            access={access}
            adminOnly
            message="Failure-alert thresholds are managed by workspace Admins."
          />
        </section>
        <section className="observability-card">
          <header>
            <div>
              <p>Historical trends</p>
              <h2>Runs, tools, and failures</h2>
            </div>
          </header>
          <div className="trend-chart">
            {trend.map((bucket) => (
              <div
                key={bucket.label}
                title={`${bucket.label}: ${bucket.runs} runs, ${bucket.tools} tool calls, ${bucket.failures} failures`}
              >
                <span className="trend-run" style={{ height: `${Math.max(3, Math.min(100, bucket.runs * 20))}%` }} />
                <span className="trend-tools" style={{ height: `${Math.max(3, Math.min(100, bucket.tools * 10))}%` }} />
                <span
                  className="trend-failure"
                  style={{ height: `${Math.max(3, Math.min(100, bucket.failures * 35))}%` }}
                />
                <small>{bucket.label}</small>
              </div>
            ))}
          </div>
          <p className="trend-legend">
            <span>Runs</span>
            <span>Tools</span>
            <span>Failures</span>
          </p>
        </section>
        <section className="observability-card">
          <header>
            <div>
              <p>Run comparison</p>
              <h2>Compare with selected run</h2>
            </div>
          </header>
          <select
            className="observability-compare"
            value={compareRunId}
            onChange={(event) => setCompareRunId(event.target.value)}
          >
            <option value="">Choose a prior run</option>
            {runs
              .filter((run) => run.id !== selectedRun?.id)
              .slice(0, 30)
              .map((run) => (
                <option key={run.id} value={run.id}>
                  {run.workflowName} · {relativeTime(run.startedAt)}
                </option>
              ))}
          </select>
          {selectedRun && comparison ? (
            <div className="comparison comparison-table">
              <span>
                <b>Metric</b>
                <b>Selected</b>
                <b>Compared</b>
              </span>
              <span>
                <b>Outcome</b>
                <i>{selectedRun.status}</i>
                <i>{comparison.status}</i>
              </span>
              <span>
                <b>Latency</b>
                <i>{duration(selectedRun)}</i>
                <i>{duration(comparison)}</i>
              </span>
              <span>
                <b>Tool calls</b>
                <i>{selectedRun.toolCalls}</i>
                <i>{comparison.toolCalls}</i>
              </span>
              <span>
                <b>Tokens</b>
                <i>{selectedRun.estimatedTokens.toLocaleString()}</i>
                <i>{comparison.estimatedTokens.toLocaleString()}</i>
              </span>
              <span>
                <b>Cost</b>
                <i>${(selectedRun.providerCostUsd ?? selectedRun.estimatedCostUsd).toFixed(4)}</i>
                <i>${(comparison.providerCostUsd ?? comparison.estimatedCostUsd).toFixed(4)}</i>
              </span>
            </div>
          ) : (
            <p className="observability-empty">
              Open a run from the timeline, then choose another run to compare outcome, latency, tools, tokens, and
              cost.
            </p>
          )}
        </section>
        <section className="observability-card">
          <header>
            <div>
              <p>Data retention</p>
              <h2>Enforced trace retention</h2>
            </div>
          </header>
          <label className="observability-control">
            Keep workflow runs for
            <select
              value={retentionDays}
              disabled={!canControl}
              onChange={(event) => void saveRetention(Number(event.target.value) as 7 | 30 | 90 | 365)}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </label>
          <p className="observability-empty">
            Expired workflow runs are deleted when this policy changes and every day thereafter.
          </p>
          {retentionNotice && <p className="observability-empty">{retentionNotice}</p>}
          <AccessNotice
            workspaceId={workspaceId}
            access={access}
            adminOnly
            message="Retention and failure-alert thresholds are managed by workspace Admins. You can view the current retention status."
          />
        </section>
      </div>
      {selectedRun && (
        <section className="run-detail" role="dialog" aria-label="Workflow run details">
          <header>
            <div>
              <p>Run detail</p>
              <h2>{selectedRun.workflowName}</h2>
            </div>
            <button onClick={() => setSelectedRun(null)}>Close</button>
          </header>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{selectedRun.status}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{new Date(selectedRun.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>{duration(selectedRun)}</dd>
            </div>
            <div>
              <dt>Tool calls</dt>
              <dd>{selectedRun.toolCalls}</dd>
            </div>
            <div>
              <dt>Provider usage</dt>
              <dd>
                {selectedRun.providerPromptTokens === null && selectedRun.providerCompletionTokens === null
                  ? "Not reported by provider"
                  : `${(selectedRun.providerPromptTokens ?? 0).toLocaleString()} input · ${(selectedRun.providerCompletionTokens ?? 0).toLocaleString()} output tokens`}
              </dd>
            </div>
            <div>
              <dt>{selectedRun.providerCostUsd === null ? "Cost estimate" : "Provider cost"}</dt>
              <dd>
                {selectedRun.providerCostUsd === null
                  ? `$${selectedRun.estimatedCostUsd.toFixed(4)} from ${selectedRun.estimatedTokens.toLocaleString()} tokens`
                  : `$${selectedRun.providerCostUsd.toFixed(4)} reported by provider`}
              </dd>
            </div>
            <div>
              <dt>Trigger</dt>
              <dd>{selectedRun.trigger.replaceAll("_", " ")}</dd>
            </div>
          </dl>
          <p>{selectedRun.detail || "The workflow completed without a recorded error detail."}</p>
          {selectedRun.inputExcerpt && (
            <>
              <h3>Input</h3>
              <pre>{selectedRun.inputExcerpt}</pre>
            </>
          )}
          {selectedRun.toolTrace.length > 0 && (
            <>
              <h3>Tool steps</h3>
              <ul className="trace-steps">
                {selectedRun.toolTrace.map((step, index) => (
                  <li key={`${step.name}-${index}`}>
                    <span className={step.status} />
                    {step.name}
                    <b>{step.durationMs}ms</b>
                  </li>
                ))}
              </ul>
            </>
          )}
          {selectedRun.outputExcerpt && (
            <>
              <h3>Output</h3>
              <pre>{selectedRun.outputExcerpt}</pre>
            </>
          )}
          <Link href={`/w/${workspaceId}/workflows`}>Open workflow →</Link>
        </section>
      )}
    </main>
  );
}
