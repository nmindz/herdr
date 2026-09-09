// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=dsh
// HERDR_INTEGRATION_VERSION=1

import { basename } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const SOURCE = "herdr:dsh";
const DISPLAY_SOURCE = "herdr:dsh-display";
const AGENT = "dsh";
const REQUEST_TIMEOUT_MS = 3000;
const PROJECTION_KEYS = ["modelSelection", "title", "tokenUsage", "contextPressure"];

export const name = "herdr-agent-state";
export const inject = ["agents"];

function paneConfig() {
  if (process.env.HERDR_ENV !== "1") return undefined;
  const paneId = process.env.HERDR_PANE_ID?.trim();
  if (!paneId) return undefined;
  const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
  return {
    paneId,
    binary: process.env.HERDR_BIN_PATH?.trim() || "herdr",
    socketEndpoint: socketEndpoint(socketPath),
  };
}

function socketEndpoint(socketPath) {
  if (!socketPath) return undefined;
  return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/**
 * The profile this process booted (`dsh --profile <name>`). Resuming a DSH
 * session needs it as well as the session id, because `--profile` is required
 * and is not recoverable from the session store. Read from argv exactly as
 * DSH's own launcher does; an embedder booted without `--profile` has no
 * reconstructable command, and reports the bare session id instead.
 */
function bootProfile(argv = process.argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      const value = argv[index + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (arg.startsWith("--profile=")) {
      return arg.slice("--profile=".length) || undefined;
    }
  }
  return undefined;
}

/**
 * `<profile>/<session id>`, which herdr splits back into a resume command. A
 * profile name can never contain `/` — DSH rejects those outright — so the
 * first separator is unambiguous.
 */
function sessionRef(profile, sessionId) {
  if (sessionId === undefined) return undefined;
  return profile === undefined ? sessionId : `${profile}/${sessionId}`;
}

/**
 * Whether this process was asked to continue an existing conversation, through
 * either resume channel DSH accepts: the launcher's env handoff or the app
 * arguments a profile boot forwards verbatim.
 */
function resumeRequested(env = process.env, argv = process.argv) {
  if (env.DSH_TUI_RESUME_SESSION?.trim()) return true;
  return argv.some(
    (arg) =>
      arg === "--resume" ||
      arg === "--continue" ||
      arg === "-c" ||
      arg.startsWith("--resume="),
  );
}

// Epoch microseconds outlive a process-local counter, so restarting DSH in the
// same pane never replays a sequence herdr already treated as newer.
let reportSeq = 0;
function nextReportSeq() {
  reportSeq = Math.max(reportSeq + 1, Date.now() * 1000);
  return reportSeq;
}

function socketRequest(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const requestId = `${SOURCE}:${process.pid}:${nextReportSeq()}`;
    const client = net.createConnection(endpoint, () => {
      client.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`herdr socket request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS,
    );
    timer.unref?.();
    client.setEncoding("utf8");
    client.on("data", (chunk) => finish(responseError(chunk)));
    client.on("error", finish);
    client.on("close", () => finish(new Error("herdr socket closed without a response")));
  });
}

function responseError(chunk) {
  const line = String(chunk).split("\n", 1)[0]?.trim();
  if (!line) return undefined;
  let response;
  try {
    response = JSON.parse(line);
  } catch (error) {
    return new Error(`invalid herdr socket response: ${String(error)}`);
  }
  if (response?.error) return new Error(`herdr socket error: ${JSON.stringify(response.error)}`);
  if (response?.result === undefined) {
    return new Error("herdr socket response carried neither result nor error");
  }
  return undefined;
}

function cliRequest(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: process.env, stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`herdr command timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`herdr command exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

/**
 * Socket-first reporting with a CLI fallback, serialized so herdr observes
 * reports in the order the rollup produced them.
 */
class Reporter {
  #config;
  #onError;
  #queue = Promise.resolve();
  #lastState;
  #lastDisplay;
  #lastSession;
  #released = true;

  constructor(config, onError) {
    this.#config = config;
    this.#onError = onError;
  }

  /**
   * Anchor the session before any state rides on it. herdr parks a
   * full-lifecycle state report whose session it has never seen, so the
   * identity has to arrive on its own report first; `startSource` is what
   * tells herdr the anchor is legitimate rather than cross-talk from another
   * process sharing the pane.
   */
  session(sessionId, startSource) {
    if (sessionId === undefined || sessionId === this.#lastSession) return;
    this.#lastSession = sessionId;
    this.#enqueue(
      "pane.report_agent_session",
      "report-agent-session",
      SOURCE,
      { agent_session_id: sessionId, session_start_source: startSource },
      [
        "--agent-session-id",
        sessionId,
        "--session-start-source",
        startSource,
      ],
      () => {
        this.#lastSession = undefined;
      },
    );
  }

  state(snapshot) {
    const desired = `${snapshot.state}\0${snapshot.message ?? ""}\0${snapshot.sessionId ?? ""}`;
    if (!this.#released && desired === this.#lastState) return;
    this.#released = false;
    this.#lastState = desired;
    const params = { state: snapshot.state };
    const args = ["--state", snapshot.state];
    if (snapshot.message !== undefined) {
      params.message = snapshot.message;
      args.push("--message", snapshot.message);
    }
    if (snapshot.sessionId !== undefined) {
      params.agent_session_id = snapshot.sessionId;
      args.push("--agent-session-id", snapshot.sessionId);
    }
    this.#enqueue("pane.report_agent", "report-agent", SOURCE, params, args, () => {
      // Both transports failed, so herdr never saw this state. Forget it or the
      // dedupe would suppress every identical rollup that follows.
      this.#lastState = undefined;
    });
  }

  // Presentation rides a sibling source so it never competes with the
  // lifecycle authority reported above.
  display(tokens) {
    const desired = JSON.stringify(tokens);
    if (desired === this.#lastDisplay) return;
    this.#lastDisplay = desired;
    const args = ["--display-agent", AGENT];
    for (const [token, value] of Object.entries(tokens)) args.push("--token", `${token}=${value}`);
    this.#enqueue(
      "pane.report_metadata",
      "report-metadata",
      DISPLAY_SOURCE,
      { display_agent: AGENT, tokens },
      args,
      () => {
        this.#lastDisplay = undefined;
      },
    );
  }

  release() {
    if (this.#released) return this.#queue;
    this.#released = true;
    this.#lastState = undefined;
    this.#enqueue("pane.release_agent", "release-agent", SOURCE, {}, []);
    return this.#queue;
  }

  #enqueue(method, command, source, params, extraArgs, onFailure) {
    const { paneId, binary, socketEndpoint: endpoint } = this.#config;
    const seq = nextReportSeq();
    const socketParams = { pane_id: paneId, source, agent: AGENT, seq, ...params };
    const args = [
      "pane",
      command,
      paneId,
      "--source",
      source,
      "--agent",
      AGENT,
      "--seq",
      String(seq),
      ...extraArgs,
    ];
    this.#queue = this.#queue
      .then(async () => {
        if (endpoint !== undefined) {
          try {
            await socketRequest(endpoint, method, socketParams);
            return;
          } catch {
            // A dead or busy socket falls back to the CLI below; only losing
            // both paths is worth a warning.
          }
        }
        await cliRequest(binary, args);
      })
      .catch((error) => {
        onFailure?.();
        this.#onError(error);
      });
  }
}

/** Unresolved approval ids folded from a session's persisted and live events. */
function unresolvedApprovals(events) {
  const pending = new Set();
  if (!Array.isArray(events)) return pending;
  for (const event of events) {
    if (event?.type === "approval/asked") pending.add(String(event.data?.id));
    else if (event?.type === "approval/decided") pending.delete(String(event.data?.id));
  }
  return pending;
}

function plural(count, singular) {
  return count === 1 ? singular : `${singular}s`;
}

/** Rollup of every root and child agent hosted by one DSH process. */
class StateTracker {
  #agents = new Map();
  #rootSessionId;

  setRootSession(sessionId) {
    this.#rootSessionId = sessionId;
  }

  upsert(agentId, status, approvals) {
    const tracked = this.#agents.get(agentId);
    if (tracked === undefined) {
      this.#agents.set(agentId, { status, approvals: new Set(approvals) });
      return;
    }
    tracked.status = status;
    tracked.approvals = new Set(approvals);
  }

  setStatus(agentId, status) {
    const tracked = this.#agents.get(agentId);
    if (tracked !== undefined) tracked.status = status;
  }

  approvalAsked(agentId, approvalId) {
    this.#agents.get(agentId)?.approvals.add(approvalId);
  }

  approvalDecided(agentId, approvalId) {
    this.#agents.get(agentId)?.approvals.delete(approvalId);
  }

  remove(agentId) {
    this.#agents.delete(agentId);
  }

  snapshot() {
    const agents = [...this.#agents.values()];
    const running = agents.filter(({ status }) => status === "running").length;
    const approvals = agents.reduce((count, { approvals }) => count + approvals.size, 0);
    const session = this.#rootSessionId === undefined ? {} : { sessionId: this.#rootSessionId };

    // A live DSH process owns the pane before its first agent exists, so an
    // empty rollup is idle; authority only returns when the plugin unloads.
    if (agents.length === 0) return { state: "idle", ...session };
    if (approvals > 0) {
      return {
        state: "blocked",
        message: `${approvals} ${plural(approvals, "approval")} waiting`,
        ...session,
      };
    }
    if (running > 0) {
      return {
        state: "working",
        message: `${running} ${plural(running, "agent")} working`,
        ...session,
      };
    }
    return {
      state: "idle",
      message: `${agents.length} ${plural(agents.length, "agent")} idle`,
      ...session,
    };
  }
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function humanizeTokens(total) {
  if (total < 1000) return String(Math.round(total));
  if (total < 1_000_000) return `${Math.round(total / 1000)}k`;
  return `${Math.round(total / 1_000_000)}M`;
}

function formatTokenTotal(usage) {
  const buckets = [
    finite(usage?.uncachedInputTokens),
    finite(usage?.outputTokens),
    finite(usage?.cacheReadTokens),
    finite(usage?.cacheWriteTokens),
  ].filter((value) => value !== undefined);
  if (buckets.length === 0) return undefined;
  return `\u03a3 ${humanizeTokens(buckets.reduce((sum, value) => sum + value, 0))}`;
}

// DSH stores no percentage, so derive it. Without a context window only the
// raw token count is honest.
function formatContextPressure(pressure) {
  const used = finite(pressure?.projectedTokens) ?? finite(pressure?.pressureTokens);
  if (used === undefined) return undefined;
  const window = finite(pressure?.contextWindow);
  if (!window) return `\u2299 ${humanizeTokens(used)}`;
  // Scale before dividing: (575000 / 1e6) * 100 lands on 57.499999999999996.
  return `\u2299 ${Math.round((used * 100) / window)}% (${humanizeTokens(used)})`;
}

function modelLabel(selection) {
  const model = selection?.model;
  if (!model) return undefined;
  const effort = selection?.reasoningEffort;
  return effort ? `${model} \u00b7 ${effort}` : model;
}

// A loopback route means a local proxy serves the model, which is what the
// provider cell already reads for other agents; anything else names its host.
function backendFromBaseUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return undefined;
  let host;
  let port;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    host = url.hostname.toLowerCase();
    port = url.port;
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return port === "11434" ? "ollama" : "local";
  }
  const parts = host.split(".");
  const label = parts.length >= 2 && ["api", "www", "inference"].includes(parts[0]) ? parts[1] : parts[0];
  return label === "" ? undefined : label;
}

// The routed provider names the cell; its configured base URL refines it to the
// backend actually serving the route.
function providerLabel(ctx, selection) {
  const provider = selection?.provider;
  if (typeof provider !== "string" || provider === "") return undefined;
  const profile = ctx.get?.("settings")?.get?.("llm-pi-ai")?.providers?.[provider];
  return backendFromBaseUrl(profile?.baseURL) ?? provider;
}

export function apply(ctx) {
  const config = paneConfig();
  if (config === undefined) return;

  const logger = ctx.logger?.("herdr");
  const reporter = new Reporter(config, (error) => {
    logger?.warn("herdr state report failed: %s", error instanceof Error ? error.message : String(error));
  });
  const tracker = new StateTracker();
  let display = { title: basename(process.cwd()) };
  let scheduled = false;
  let disposed = false;

  const flush = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const snapshot = tracker.snapshot();
      reporter.state(snapshot);
      reporter.display(displayTokens(snapshot, display));
    });
  };

  // Register cleanup first so listeners unwind before the final release.
  ctx.effect(() => async () => {
    disposed = true;
    await reporter.release();
  }, "herdr agent state");

  const profile = bootProfile();
  const startSource = resumeRequested() ? "resume" : "startup";
  const syncRootSession = () => {
    const root = ctx.agents.roots?.()[0];
    const ref = root === undefined ? undefined : sessionRef(profile, String(root.id));
    tracker.setRootSession(ref);
    reporter.session(ref, startSource);
  };

  const track = (agent) => {
    if (agent === undefined) return;
    tracker.upsert(
      String(agent.id),
      agent.status,
      unresolvedApprovals(agent.session?.snapshotEvents?.()),
    );
  };

  for (const agent of ctx.agents.list?.() ?? []) track(agent);
  syncRootSession();
  flush();

  ctx.on("agent/created", ({ agent }) => {
    track(agent);
    syncRootSession();
    flush();
  });
  ctx.on("agent/status", ({ agent, status }) => {
    tracker.setStatus(String(agent.id), status);
    flush();
  });
  ctx.on("agent/disposed", ({ agent }) => {
    tracker.remove(String(agent.id));
    syncRootSession();
    flush();
  });
  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "approval/asked") {
      tracker.approvalAsked(String(session.id), String(event.data?.id));
      flush();
    } else if (type === "approval/decided") {
      tracker.approvalDecided(String(session.id), String(event.data?.id));
      flush();
    }
    const next = sessionDisplay(ctx, session);
    if (next !== undefined) {
      display = { ...display, ...next };
      flush();
    }
  });
}

/**
 * Title, usage and context live in session projections rather than on the
 * agent, so they are readable before the first agent exists. `ctx.get` reads
 * the service without declaring it in `inject`, which would otherwise throw on
 * every read and leave the row with nothing but the rollup; a profile that
 * never loads the service simply publishes no usage tokens.
 */
function sessionDisplay(ctx, session) {
  try {
    const values = ctx.get?.("sessionProjections")?.snapshot(session, PROJECTION_KEYS)?.values;
    if (values === undefined) return undefined;
    const next = {};
    const selection = values.modelSelection?.next;
    const model = modelLabel(selection);
    if (model !== undefined) next.model = model;
    const provider = providerLabel(ctx, selection);
    if (provider !== undefined) next.provider = provider;
    if (values.title) next.title = values.title;
    const limit = formatTokenTotal(values.tokenUsage);
    if (limit !== undefined) next.limit = limit;
    const context = formatContextPressure(values.contextPressure);
    if (context !== undefined) next.context = context;
    return next;
  } catch {
    // A projection or settings shape change must not break state reporting.
    return undefined;
  }
}

/**
 * Mirrored onto the token names herdr sidebars already compose with, so an
 * existing `ui.sidebar.agents` layout renders DSH without being rewritten.
 */
function displayTokens(snapshot, display) {
  const tokens = {};
  const rollup = snapshot.message ?? "idle";
  // The rollup stands in for the context meter until the first LLM request
  // gives DSH a window to measure against.
  tokens.context = display.context ?? rollup;
  tokens.dsh_context = tokens.context;
  tokens.dsh_rollup = rollup;
  if (display.title !== undefined) {
    tokens.title = display.title;
    tokens.dsh_title = display.title;
  }
  if (display.limit !== undefined) {
    tokens.limit = display.limit;
    tokens.dsh_limit = display.limit;
  }
  // usagebar owns `provider` for the agents it supports and ignores dsh, so a
  // DSH pane fills the cell itself; the model stays on a private token.
  if (display.provider !== undefined) {
    tokens.provider = display.provider;
    tokens.dsh_provider = display.provider;
  }
  if (display.model !== undefined) tokens.dsh_model = display.model;
  return tokens;
}
