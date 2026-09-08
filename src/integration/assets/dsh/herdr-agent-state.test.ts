import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const requests: unknown[] = [];
const commands: Array<{ command: string; args: string[] }> = [];
const connections: unknown[] = [];
let importCounter = 0;

mock.module("node:net", () => ({
  default: {
    createConnection(_endpoint: string, onConnect: () => void) {
      const handlers = new Map<string, (chunk?: unknown) => void>();
      const client = {
        write(input: string) {
          const request = JSON.parse(input.trim()) as { id: string };
          requests.push(request);
          // A closed socket without a result line is an error for the asset.
          queueMicrotask(() =>
            client.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`),
          );
        },
        setEncoding() {},
        on(event: string, handler: (chunk?: unknown) => void) {
          handlers.set(event, handler);
        },
        destroy() {},
        emit(event: string, chunk?: unknown) {
          handlers.get(event)?.(chunk);
        },
      };
      connections.push(client);
      queueMicrotask(onConnect);
      return client;
    },
  },
}));

mock.module("node:child_process", () => ({
  spawn(command: string, args: string[]) {
    commands.push({ command, args });
    const handlers = new Map<string, (code: number | null, signal: string | null) => void>();
    const child = {
      once(event: string, handler: (code: number | null, signal: string | null) => void) {
        handlers.set(event, handler);
        return child;
      },
      kill() {},
    };
    queueMicrotask(() => handlers.get("close")?.(0, null));
    return child;
  },
}));

const realArgv = process.argv;

beforeEach(() => {
  requests.length = 0;
  commands.length = 0;
  connections.length = 0;
  process.argv = [...realArgv];
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "test.sock";
  process.env.HERDR_PANE_ID = "test:p1";
  delete process.env.HERDR_BIN_PATH;
});

afterEach(() => {
  process.argv = realArgv;
});

async function loadAsset() {
  importCounter += 1;
  return await import(`./herdr-agent-state.mjs?test=${importCounter}`);
}

// Reports are coalesced with queueMicrotask and serialized on a promise queue,
// so one macrotask hop drains every pending report.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type FakeAgent = {
  id: string;
  status: string;
  session: { snapshotEvents: () => unknown[] };
};

function fakeAgent(id: string, status: string, events: unknown[] = []): FakeAgent {
  return { id, status, session: { snapshotEvents: () => events } };
}

function fakeContext(
  options: {
    agents?: FakeAgent[];
    roots?: Array<{ id: string }>;
    projections?: Record<string, unknown>;
  } = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const disposers: Array<() => Promise<void>> = [];

  return {
    ctx: {
      logger: (_tag: string) => ({ warn() {} }),
      effect(factory: () => () => Promise<void>, _label: string) {
        disposers.push(factory());
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
      },
      agents: {
        list: () => options.agents ?? [],
        roots: () => options.roots ?? [],
      },
      sessionProjections:
        options.projections === undefined
          ? undefined
          : { snapshot: () => ({ values: options.projections }) },
    },
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) await dispose();
    },
  };
}

function methodRequests(method: string): unknown[] {
  return requests.filter((request) => requestMethod(request) === method);
}

test("does nothing outside a herdr pane", async () => {
  process.env.HERDR_ENV = "0";
  const { apply } = await loadAsset();
  const host = fakeContext({ agents: [fakeAgent("s1", "running")] });

  apply(host.ctx);
  host.emit("agent/status", { agent: { id: "s1" }, status: "running" });
  await settle();

  expect(requests).toEqual([]);
  expect(commands).toEqual([]);
  expect(connections).toEqual([]);
});

test("claims the pane as idle on apply", async () => {
  const { apply } = await loadAsset();
  const host = fakeContext();

  apply(host.ctx);
  await settle();

  expect(requests.map(requestMethod)).toEqual(["pane.report_agent", "pane.report_metadata"]);
  const claim = requests[0];
  expect(requestParam(claim, "pane_id")).toBe("test:p1");
  expect(requestParam(claim, "source")).toBe("herdr:dsh");
  expect(requestParam(claim, "agent")).toBe("dsh");
  expect(requestParam(claim, "seq")).toEqual(expect.any(Number));
  expect(requestParam(claim, "state")).toBe("idle");
  expect(requestParam(claim, "message")).toBeUndefined();
  expect(requestParam(claim, "agent_session_id")).toBeUndefined();
});

test("reports working with the root session id", async () => {
  const { apply } = await loadAsset();
  const host = fakeContext({
    agents: [fakeAgent("s1", "idle")],
    roots: [{ id: "root-1" }],
  });

  apply(host.ctx);
  await settle();
  host.emit("agent/status", { agent: { id: "s1" }, status: "running" });
  await settle();

  const states = methodRequests("pane.report_agent");
  expect(states.map((request) => requestParam(request, "state"))).toEqual(["idle", "working"]);
  expect(states.map((request) => requestParam(request, "message"))).toEqual([
    "1 agent idle",
    "1 agent working",
  ]);
  expect(states.map((request) => requestParam(request, "agent_session_id"))).toEqual([
    "root-1",
    "root-1",
  ]);
});

test("pairs the booted profile with the root session id so herdr can resume it", async () => {
  process.argv = ["node", "dsh", "--profile", "tui"];
  const { apply } = await loadAsset();
  const host = fakeContext({
    agents: [fakeAgent("s1", "idle")],
    roots: [{ id: "cc147281-69e5-46b3-a80a-31f3f3d9bf63" }],
  });

  apply(host.ctx);
  await settle();

  expect(requestParam(methodRequests("pane.report_agent")[0], "agent_session_id")).toBe(
    "tui/cc147281-69e5-46b3-a80a-31f3f3d9bf63",
  );
});

test("anchors the session identity before the state that rides on it", async () => {
  process.argv = ["node", "dsh", "--profile", "tui"];
  const { apply } = await loadAsset();
  const host = fakeContext({
    agents: [fakeAgent("s1", "idle")],
    roots: [{ id: "sess-1" }],
  });

  apply(host.ctx);
  await settle();

  // herdr parks a full-lifecycle state report for a session it has not seen,
  // so the identity report must come first.
  const methods = requests.map(requestMethod);
  expect(methods.indexOf("pane.report_agent_session")).toBeLessThan(
    methods.indexOf("pane.report_agent"),
  );
  const anchor = methodRequests("pane.report_agent_session")[0];
  expect(requestParam(anchor, "source")).toBe("herdr:dsh");
  expect(requestParam(anchor, "agent")).toBe("dsh");
  expect(requestParam(anchor, "agent_session_id")).toBe("tui/sess-1");
  expect(requestParam(anchor, "session_start_source")).toBe("startup");
  expect(requestParam(anchor, "seq")).toEqual(expect.any(Number));
});

test("anchors a resumed boot as a resume, not a fresh startup", async () => {
  process.argv = ["node", "dsh", "--profile", "tui", "--resume", "sess-1"];
  const { apply } = await loadAsset();
  const host = fakeContext({ agents: [fakeAgent("s1", "idle")], roots: [{ id: "sess-1" }] });

  apply(host.ctx);
  await settle();

  expect(
    requestParam(methodRequests("pane.report_agent_session")[0], "session_start_source"),
  ).toBe("resume");
});

test("treats the launcher env handoff as a resume too", async () => {
  process.argv = ["node", "dsh", "--profile", "tui"];
  process.env.DSH_TUI_RESUME_SESSION = "sess-1";
  try {
    const { apply } = await loadAsset();
    const host = fakeContext({ agents: [fakeAgent("s1", "idle")], roots: [{ id: "sess-1" }] });

    apply(host.ctx);
    await settle();

    expect(
      requestParam(methodRequests("pane.report_agent_session")[0], "session_start_source"),
    ).toBe("resume");
  } finally {
    delete process.env.DSH_TUI_RESUME_SESSION;
  }
});

test("anchors each root session once", async () => {
  process.argv = ["node", "dsh", "--profile", "tui"];
  const { apply } = await loadAsset();
  const host = fakeContext({ agents: [fakeAgent("s1", "idle")], roots: [{ id: "sess-1" }] });

  apply(host.ctx);
  await settle();
  host.emit("agent/status", { agent: { id: "s1" }, status: "running" });
  await settle();
  host.emit("agent/created", { agent: fakeAgent("s2", "running") });
  await settle();

  expect(methodRequests("pane.report_agent_session")).toHaveLength(1);
});

test("accepts the --profile=<name> spelling", async () => {
  process.argv = ["node", "dsh", "--profile=web"];
  const { apply } = await loadAsset();
  const host = fakeContext({ agents: [fakeAgent("s1", "idle")], roots: [{ id: "s1" }] });

  apply(host.ctx);
  await settle();

  expect(requestParam(methodRequests("pane.report_agent")[0], "agent_session_id")).toBe("web/s1");
});

test("reports a bare session id when no profile booted the process", async () => {
  process.argv = ["node", "dsh", "--config", "cordis.yml"];
  const { apply } = await loadAsset();
  const host = fakeContext({ agents: [fakeAgent("s1", "idle")], roots: [{ id: "s1" }] });

  apply(host.ctx);
  await settle();

  expect(requestParam(methodRequests("pane.report_agent")[0], "agent_session_id")).toBe("s1");
});

test("reports blocked until the approval is decided", async () => {
  const { apply } = await loadAsset();
  const host = fakeContext({
    agents: [fakeAgent("s1", "running")],
    roots: [{ id: "root-1" }],
  });

  apply(host.ctx);
  await settle();
  host.emit("session/event", { id: "s1" }, { type: "approval/asked", data: { id: "ap-1" } });
  await settle();
  host.emit("session/event", { id: "s1" }, { type: "approval/decided", data: { id: "ap-1" } });
  await settle();

  const states = methodRequests("pane.report_agent");
  expect(states.map((request) => requestParam(request, "state"))).toEqual([
    "working",
    "blocked",
    "working",
  ]);
  expect(states.map((request) => requestParam(request, "message"))).toEqual([
    "1 agent working",
    "1 approval waiting",
    "1 agent working",
  ]);
});

test("seeds unresolved approvals from session snapshot events", async () => {
  const { apply } = await loadAsset();
  const host = fakeContext({
    agents: [
      fakeAgent("s1", "running", [
        { type: "approval/asked", data: { id: "ap-0" } },
        { type: "approval/asked", data: { id: "ap-1" } },
        { type: "approval/decided", data: { id: "ap-1" } },
      ]),
    ],
  });

  apply(host.ctx);
  await settle();
  host.emit("session/event", { id: "s1" }, { type: "approval/decided", data: { id: "ap-0" } });
  await settle();

  const states = methodRequests("pane.report_agent");
  expect(states.map((request) => requestParam(request, "state"))).toEqual(["blocked", "working"]);
  expect(states.map((request) => requestParam(request, "message"))).toEqual([
    "1 approval waiting",
    "1 agent working",
  ]);
});

test("reports display tokens on the display source", async () => {
  const { apply } = await loadAsset();
  const host = fakeContext({
    projections: {
      title: "session title",
      modelSelection: { next: { model: "m1", reasoningEffort: "high" } },
      tokenUsage: { outputTokens: 1500 },
      contextPressure: { projectedTokens: 500_000, contextWindow: 1_000_000 },
    },
  });

  apply(host.ctx);
  await settle();
  host.emit("session/event", { id: "s1" }, { type: "session/started" });
  await settle();

  const metadata = methodRequests("pane.report_metadata");
  const latest = metadata[metadata.length - 1];
  expect(requestParam(latest, "source")).toBe("herdr:dsh-display");
  expect(requestParam(latest, "agent")).toBe("dsh");
  expect(requestParam(latest, "display_agent")).toBe("dsh");
  expect(requestParam(latest, "tokens")).toEqual({
    context: "\u2299 50% (500k)",
    dsh_context: "\u2299 50% (500k)",
    dsh_rollup: "idle",
    title: "session title",
    dsh_title: "session title",
    limit: "\u03a3 2k",
    dsh_limit: "\u03a3 2k",
    dsh_model: "m1 \u00b7 high",
  });
});

test("releases the pane when the effect disposer runs", async () => {
  const { apply } = await loadAsset();
  const host = fakeContext();

  apply(host.ctx);
  await settle();
  await host.dispose();
  await settle();

  const release = methodRequests("pane.release_agent");
  expect(release).toHaveLength(1);
  expect(requestParam(release[0], "pane_id")).toBe("test:p1");
  expect(requestParam(release[0], "source")).toBe("herdr:dsh");
  expect(requestParam(release[0], "agent")).toBe("dsh");
  expect(requestParam(release[0], "seq")).toEqual(expect.any(Number));
  expect(requestParam(release[0], "state")).toBeUndefined();
});

test("falls back to the herdr CLI without a socket path", async () => {
  delete process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_BIN_PATH = "/tmp/herdr-test-bin";
  const { apply } = await loadAsset();
  const host = fakeContext();

  apply(host.ctx);
  await settle();

  expect(connections).toEqual([]);
  expect(requests).toEqual([]);
  expect(commands[0]?.command).toBe("/tmp/herdr-test-bin");
  expect(commands[0]?.args).toEqual([
    "pane",
    "report-agent",
    "test:p1",
    "--source",
    "herdr:dsh",
    "--agent",
    "dsh",
    "--seq",
    expect.any(String),
    "--state",
    "idle",
  ]);
  expect(commands[1]?.args.slice(0, 2)).toEqual(["pane", "report-metadata"]);
});

function requestMethod(request: unknown): unknown {
  return isRecord(request) ? request.method : undefined;
}

function requestParam(request: unknown, name: string): unknown {
  if (!isRecord(request) || !isRecord(request.params)) {
    return undefined;
  }
  return request.params[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
