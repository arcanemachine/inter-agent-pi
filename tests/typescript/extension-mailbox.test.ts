import { test } from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

import ext, {
  _setSpawnForTest,
  _setReloadCarrierForTest,
  _setStopTimeoutsForTest,
} from "../../src/index.js";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { ReloadHandoff, ReloadHandoffCarrier } from "../../src/mailbox.js";

// ── Fake Pi runtime ─────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

interface RecordedMessage {
  message: {
    customType: string;
    content: string;
    display?: boolean;
    details: unknown;
  };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

interface BranchEntry {
  type: string;
  customType: string;
  data: unknown;
}

/** Minimal stand-in for a Pi ChildProcess driven by the test. */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  // The extension sets this to mark an expected (disconnect) stop.
  [key: string]: unknown;
  // When true, kill() records the signal but never emits exit/close, simulating
  // a hung child that drives stopListener to time out and return false.
  hangOnKill = false;

  emitStdout(line: string): void {
    this.stdout.emit("data", Buffer.from(line));
  }

  emitStderr(line: string): void {
    this.stderr.emit("data", Buffer.from(line));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    // A hung child records the kill attempt but never exits, so stopListener's
    // SIGTERM/SIGKILL races time out and it returns false. signalCode is NOT
    // set so stopListener's exit checks stay false until the real timeouts.
    if (this.hangOnKill) return false;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  }

  /** Mark a clean exit (for status/exec scripts). */
  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }

  unref(): void {
    // No-op for the fake.
  }
}

class FakeCtx {
  readonly sessionManager: {
    getBranch(): BranchEntry[];
    getSessionId(): string;
  };
  readonly ui: {
    notify: (m: string, t?: string) => void;
    setStatus: (k: string, t: string | undefined) => void;
  };
  cwd: string;
  idle = true;
  pendingMessages = false;
  sessionId = "reload-session-1";

  constructor(
    branch: BranchEntry[],
    notifyLog: { message: string; type: string }[],
  ) {
    this.sessionManager = {
      getBranch: () => branch,
      getSessionId: () => this.sessionId,
    };
    this.ui = {
      notify: (message, type = "info") => notifyLog.push({ message, type }),
      setStatus: () => {},
    };
    this.cwd = process.cwd();
  }

  isIdle(): boolean {
    return this.idle;
  }

  hasPendingMessages(): boolean {
    return this.pendingMessages;
  }
}

class FakePi {
  readonly commands = new Map<
    string,
    { handler: Handler; description?: string }
  >();
  readonly tools = new Map<string, { execute: Handler }>();
  readonly renderers = new Map<string, unknown>();
  readonly flags = new Map<string, unknown>();
  readonly handlers = new Map<string, Handler[]>();
  readonly messages: RecordedMessage[] = [];
  readonly branch: BranchEntry[] = [];
  readonly notifyLog: { message: string; type: string }[] = [];
  readonly ctx: FakeCtx;
  #flagValue: unknown = undefined;

  constructor() {
    this.ctx = new FakeCtx(this.branch, this.notifyLog);
  }

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(
    name: string,
    options: { handler: Handler; description?: string },
  ): void {
    this.commands.set(name, {
      handler: options.handler,
      description: options.description,
    });
  }

  registerTool(tool: { name: string; execute: Handler }): void {
    this.tools.set(tool.name, tool);
  }

  registerMessageRenderer(customType: string, renderer: unknown): void {
    this.renderers.set(customType, renderer);
  }

  registerFlag(name: string, options: unknown): void {
    this.flags.set(name, options);
  }

  getFlag(_name: string): unknown {
    return this.#flagValue;
  }

  setFlagValue(value: unknown): void {
    this.#flagValue = value;
  }

  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details: unknown;
    },
    options: { triggerTurn?: boolean; deliverAs?: string },
  ): void {
    this.messages.push({ message, options });
  }

  appendEntry(customType: string, data: unknown): void {
    this.branch.push({ type: "custom", customType, data });
  }
}

type ContextMessage = ContextEvent["messages"][number];
type CustomContextMessage = Extract<ContextMessage, { role: "custom" }>;
type ContextResult = { messages?: ContextEvent["messages"] };

type TestStopReason = "error" | "aborted" | "toolUse";

function contextMarker(customType: string): CustomContextMessage {
  return {
    role: "custom",
    customType,
    content: "internal agent body",
    display: false,
    details: { displayContent: "user-facing summary", marker: customType },
    timestamp: 1,
  } as CustomContextMessage;
}

function contextAssistant(
  stopReason: TestStopReason,
  toolCallIds: string[],
): ContextMessage {
  return {
    role: "assistant",
    content: toolCallIds.map((id) => ({
      type: "toolCall",
      id,
      name: "bash",
      arguments: { command: "pwd" },
    })),
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  } as ContextMessage;
}

function contextToolResult(
  toolCallId: string,
  text = "tool output",
): ContextMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  } as ContextMessage;
}

async function runContextHandler(
  pi: FakePi,
  messages: ContextEvent["messages"],
): Promise<ContextResult | undefined> {
  const handlers = pi.handlers.get("context");
  assert.ok(handlers, "context handler not registered");
  let result: unknown;
  for (const handler of handlers) {
    result = await handler({ type: "context", messages }, pi.ctx);
  }
  return result as ContextResult | undefined;
}

// ── Environment + spawn fakes ───────────────────────────────────────────────

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupEnv(opts: {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
}): { pi: FakePi; home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "ia-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-cwd-"));
  mkdirSync(join(cwd, ".venv", "bin"), { recursive: true });
  for (const name of [
    "inter-agent-pi",
    "inter-agent-connect",
    "inter-agent-server",
  ]) {
    writeFileSync(join(cwd, ".venv", "bin", name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(cwd, ".venv", "bin", name), 0o755);
  }
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  if (opts.global) {
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ interAgent: opts.global }),
    );
  }
  // Project settings always anchor getScripts at the temp .venv/bin stubs so
  // the faked connect/status flow resolves without a real inter-agent install.
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      interAgent: { ...(opts.project ?? {}), projectPath: cwd },
    }),
  );
  return { pi: new FakePi(), home, cwd };
}

function withEnv(
  opts: { global?: Record<string, unknown>; project?: Record<string, unknown> },
  fn: (api: { pi: FakePi; listeners: FakeChildProcess[] }) => Promise<void>,
): Promise<void> {
  return (async () => {
    const env = setupEnv(opts);
    const oldHome = process.env.HOME;
    const oldCwd = process.cwd();
    process.env.HOME = env.home;
    process.chdir(env.cwd);
    // spawn is fully faked; getScripts resolves the project .venv/bin stubs so
    // the connect/status flow proceeds without a real inter-agent install.
    const listeners: FakeChildProcess[] = [];
    _setSpawnForTest(((
      cmd: string,
      args: string[],
      options: unknown,
    ): FakeChildProcess => {
      // Record the invocation so propagation tests can inspect the resolved
      // child environment and arguments without spawning a real process.
      const record = (proc: FakeChildProcess): FakeChildProcess => {
        proc.spawnCmd = cmd;
        proc.spawnArgs = args;
        proc.spawnEnv = (
          options as { env?: Record<string, string | undefined> } | undefined
        )?.env;
        return proc;
      };
      if (args[0] === "status") {
        const proc = record(new FakeChildProcess());
        queueMicrotask(() => {
          proc.emitStdout(
            JSON.stringify({
              state: "available",
              message: "available",
              server_reachable: true,
            }) + "\n",
          );
          proc.exit(0);
        });
        return proc;
      }
      if (args[0] === "connect") {
        const proc = record(new FakeChildProcess());
        listeners.push(proc);
        return proc;
      }
      const proc = record(new FakeChildProcess());
      queueMicrotask(() => proc.exit(0));
      return proc;
    }) as never);

    try {
      ext(env.pi as never);
      // Establish session context (no flag, no saved state) so currentCtx is
      // bound before commands run.
      await runHandler(env.pi, "session_start", {}, env.pi.ctx);
      await fn({ pi: env.pi, listeners });
    } finally {
      await runHandler(env.pi, "session_shutdown");
      process.env.HOME = oldHome;
      _setSpawnForTest(null);
      process.chdir(oldCwd);
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.cwd, { recursive: true, force: true });
    }
  })();
}

async function runHandler(
  pi: FakePi,
  event: string,
  ...args: unknown[]
): Promise<void> {
  const list = pi.handlers.get(event);
  if (!list) return;
  for (const handler of list) {
    await handler(...args);
  }
}

function interAgentCommand(pi: FakePi): { handler: Handler } {
  const cmd = pi.commands.get("inter-agent");
  if (!cmd) throw new Error("inter-agent command not registered");
  return cmd;
}

function readTool(pi: FakePi): { execute: Handler } {
  const tool = pi.tools.get("inter_agent_read_messages");
  if (!tool) throw new Error("inter_agent_read_messages tool not registered");
  return tool;
}

const MARKER = "SECRET-MARKER-extension-body";

class FakeCarrier implements ReloadHandoffCarrier {
  gen = 0;
  slot: ReloadHandoff | null = null;
  getGeneration(): number {
    return this.gen;
  }
  store(handoff: ReloadHandoff): void {
    this.gen = handoff.gen;
    this.slot = handoff;
  }
  take(): { handoff: ReloadHandoff | null; genBefore: number } {
    const handoff = this.slot;
    const genBefore = this.gen;
    this.slot = null;
    this.gen = this.gen + 1;
    return { handoff, genBefore };
  }
  reset(): void {
    this.slot = null;
    this.gen = this.gen + 1;
  }
}

/** Emit a welcome then a queued direct msg frame on the current listener. */
function emitDirectMsg(
  listener: FakeChildProcess,
  name: string,
  body = MARKER,
): void {
  listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
  listener.emitStdout(
    JSON.stringify({
      op: "msg",
      msg_id: "m1",
      from_name: "alice",
      text: body,
      to: name,
    }) + "\n",
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("context filter removes results paired with error and aborted assistants", async () => {
  await withEnv({}, async ({ pi }) => {
    for (const stopReason of ["error", "aborted"] as const) {
      const marker = contextMarker("inter-agent-message");
      const result = await runContextHandler(pi, [
        marker,
        contextAssistant(stopReason, ["call-suppressed"]),
        contextToolResult("call-suppressed"),
      ]);
      assert.deepEqual(result?.messages, [
        marker,
        contextAssistant(stopReason, ["call-suppressed"]),
      ]);
    }
  });
});

test("context filter preserves a valid assistant and tool result pairing", async () => {
  await withEnv({}, async ({ pi }) => {
    const marker = contextMarker("inter-agent-message");
    const suppressed = await runContextHandler(pi, [
      marker,
      contextAssistant("error", ["call-valid"]),
      contextToolResult("call-valid"),
    ]);
    assert.ok(suppressed);

    const assistant = contextAssistant("toolUse", ["call-valid"]);
    const toolResult = contextToolResult("call-valid");
    const result = await runContextHandler(pi, [marker, assistant, toolResult]);

    assert.equal(result, undefined);
  });
});

test("context filter preserves a valid pairing after a reused tool-call ID", async () => {
  await withEnv({}, async ({ pi }) => {
    const marker = contextMarker("inter-agent-message");
    const validAssistant = contextAssistant("toolUse", ["call-reused"]);
    const freshResult = contextToolResult("call-reused", "fresh output");
    const result = await runContextHandler(pi, [
      marker,
      contextAssistant("error", ["call-reused"]),
      contextToolResult("call-reused", "stale output"),
      validAssistant,
      freshResult,
    ]);

    assert.equal(result?.messages?.length, 4);
    assert.equal(result?.messages?.[0], marker);
    assert.equal(result?.messages?.[1].role, "assistant");
    assert.equal(result?.messages?.[2], validAssistant);
    assert.equal(result?.messages?.[3], freshResult);
  });
});

test("context filter removes results for every suppressed tool-call ID", async () => {
  await withEnv({}, async ({ pi }) => {
    const marker = contextMarker("inter-agent-message");
    const result = await runContextHandler(pi, [
      marker,
      contextAssistant("aborted", ["call-one", "call-two"]),
      contextToolResult("call-one"),
      contextToolResult("call-two"),
    ]);

    assert.equal(result?.messages?.length, 2);
    assert.equal(result?.messages?.[0], marker);
    assert.equal(result?.messages?.[1].role, "assistant");
  });
});

test("context filter preserves unmatched tool results", async () => {
  await withEnv({}, async ({ pi }) => {
    const messages = [
      contextMarker("inter-agent-message"),
      contextToolResult("call-unmatched"),
    ];
    const result = await runContextHandler(pi, messages);

    assert.equal(result, undefined);
  });
});

test("context filter stays inactive without an exact inter-agent marker", async () => {
  await withEnv({}, async ({ pi }) => {
    const contexts = [
      [
        contextAssistant("error", ["call-no-marker"]),
        contextToolResult("call-no-marker"),
      ],
      [
        contextMarker("other-custom-type"),
        contextAssistant("error", ["call-unrelated-marker"]),
        contextToolResult("call-unrelated-marker"),
      ],
    ];

    for (const messages of contexts) {
      const result = await runContextHandler(pi, messages);
      assert.equal(result, undefined);
    }
  });
});

test("context filter activates for both inter-agent custom message types", async () => {
  await withEnv({}, async ({ pi }) => {
    for (const customType of ["inter-agent-message", "inter-agent-mailbox"]) {
      const marker = contextMarker(customType);
      const result = await runContextHandler(pi, [
        marker,
        contextAssistant("error", ["call-marker"]),
        contextToolResult("call-marker"),
      ]);
      assert.equal(result?.messages?.length, 2);
      assert.equal(result?.messages?.[0], marker);
      assert.equal(result?.messages?.[1].role, "assistant");
    }
  });
});

test("context filter does not mutate messages or affect UI fields", async () => {
  await withEnv({}, async ({ pi }) => {
    const marker = contextMarker("inter-agent-mailbox");
    const messages = [
      marker,
      contextAssistant("error", ["call-unchanged"]),
      contextToolResult("call-unchanged"),
    ];
    const before = structuredClone(messages);
    const result = await runContextHandler(pi, messages);

    assert.deepEqual(messages, before);
    assert.equal(pi.notifyLog.length, 0);
    assert.equal(pi.messages.length, 0);
    const kept = result?.messages?.[0];
    assert.ok(kept);
    assert.equal(kept.role, "custom");
    if (kept.role === "custom") {
      assert.equal(kept.customType, marker.customType);
      assert.equal(kept.content, marker.content);
      assert.equal(kept.display, marker.display);
      assert.deepEqual(kept.details, marker.details);
    }
  });
});

test("invalid config keys warn exactly once after UI context is available", async () => {
  await withEnv(
    {
      global: { deliveryMode: "bogus", mailboxNoticeDebounceMs: 99999 },
    },
    async ({ pi }) => {
      // First session_start fires both warnings once.
      await runHandler(pi, "session_start", {}, pi.ctx);
      const modeWarnings = pi.notifyLog.filter((n) =>
        n.message.includes("interAgent.deliveryMode"),
      );
      const debounceWarnings = pi.notifyLog.filter((n) =>
        n.message.includes("interAgent.mailboxNoticeDebounceMs"),
      );
      assert.equal(modeWarnings.length, 1);
      assert.equal(debounceWarnings.length, 1);

      // A second session_start must not repeat them.
      const before = pi.notifyLog.length;
      await runHandler(pi, "session_start", {}, pi.ctx);
      const newMode = pi.notifyLog
        .slice(before)
        .filter((n) => n.message.includes("interAgent.deliveryMode"));
      const newDebounce = pi.notifyLog
        .slice(before)
        .filter((n) =>
          n.message.includes("interAgent.mailboxNoticeDebounceMs"),
        );
      assert.equal(newMode.length, 0);
      assert.equal(newDebounce.length, 0);
    },
  );
});

test("delivery command overrides the session mode for future arrivals only", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler(`connect rx`, pi.ctx);
      const listener = listeners[listeners.length - 1];
      // Default queued: body is hidden behind a metadata-only mailbox notice.
      emitDirectMsg(listener, "rx");
      await tick();
      assert.ok(
        pi.messages.some((m) => m.message.customType === "inter-agent-mailbox"),
      );
      assert.ok(
        !pi.messages.some(
          (m) => m.message.customType === "inter-agent-message",
        ),
      );
      const queuedNotice = pi.messages.find(
        (m) => m.message.customType === "inter-agent-mailbox",
      );
      assert.ok(queuedNotice);
      assert.ok(
        !JSON.stringify(queuedNotice!.message.details).includes(MARKER),
      );

      // Switch to immediate for future arrivals only; the queued body stays unread.
      await cmd.handler("delivery immediate", pi.ctx);
      const overrideNotify = pi.notifyLog
        .slice()
        .reverse()
        .find((n) =>
          n.message.includes("future arrivals will be delivered immediately"),
        );
      assert.ok(overrideNotify, "immediate override notify not shown");
      assert.ok(
        overrideNotify!.message.includes("unread message(s) already queued"),
      );

      // Read the previously queued body via the read tool to prove it was retained.
      const result = (await readTool(pi).execute(
        "c",
        {},
        undefined,
        undefined,
        pi.ctx,
      )) as {
        details: { read: { body: string }[] };
      };
      assert.equal(result.details.read.length, 1);
      assert.equal(result.details.read[0].body, MARKER);
    },
  );
});

test("delivery command accepts any leading i/q string for the mode", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi }) => {
      const cmd = interAgentCommand(pi);

      // Only the first character matters: imm, immediate, and immaculate all
      // resolve to immediate.
      for (const arg of ["imm", "immediate", "immaculate"]) {
        pi.notifyLog.length = 0;
        await cmd.handler(`delivery ${arg}`, pi.ctx);
        const immediateNotify = pi.notifyLog
          .slice()
          .reverse()
          .find((n) =>
            n.message.includes("future arrivals will be delivered immediately"),
          );
        assert.ok(immediateNotify, `alias ${arg} did not switch to immediate`);
      }

      // qu, queued, and quesadilla all resolve to queued.
      for (const arg of ["qu", "queued", "quesadilla"]) {
        pi.notifyLog.length = 0;
        await cmd.handler(`delivery ${arg}`, pi.ctx);
        const queuedNotify = pi.notifyLog
          .slice()
          .reverse()
          .find((n) =>
            n.message.includes(
              "future arrivals will be delivered into the mailbox queue",
            ),
          );
        assert.ok(queuedNotify, `alias ${arg} did not switch to queued`);
      }
    },
  );
});

test("project settings override global settings for delivery mode precedence", async () => {
  // Global says immediate; project overrides to queued. Project wins.
  await withEnv(
    {
      global: { deliveryMode: "immediate" },
      project: { projectPath: process.cwd(), deliveryMode: "queued" },
    },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      emitDirectMsg(listeners[listeners.length - 1], "rx");
      await tick();
      assert.ok(
        pi.messages.some((m) => m.message.customType === "inter-agent-mailbox"),
      );
      assert.ok(
        !pi.messages.some(
          (m) => m.message.customType === "inter-agent-message",
        ),
      );
    },
  );

  // With no project override, global immediate wins.
  await withEnv(
    {
      global: { deliveryMode: "immediate" },
      project: { projectPath: process.cwd() },
    },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      emitDirectMsg(listeners[listeners.length - 1], "rx");
      await tick();
      assert.ok(
        pi.messages.some((m) => m.message.customType === "inter-agent-message"),
      );
      // Immediate delivery never enters the mailbox.
      const read = (await readTool(pi).execute(
        "c",
        {},
        undefined,
        undefined,
        pi.ctx,
      )) as {
        details: { read: unknown[] };
      };
      assert.equal(read.details.read.length, 0);
    },
  );
});

test("queued user notification is metadata-only while immediate shows the bounded body", async () => {
  // Immediate mode: the user notification carries the bounded body, matching the
  // original behavior; queued mode notifies metadata only.
  await withEnv(
    {
      global: { deliveryMode: "immediate" },
      project: { projectPath: process.cwd() },
    },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      emitDirectMsg(listeners[listeners.length - 1], "rx");
      await tick();
      const immediateNotify = pi.notifyLog.find((n) =>
        n.message.includes("[inter-agent] alice"),
      );
      assert.ok(immediateNotify, "immediate inbound notify not shown");
      assert.ok(immediateNotify!.message.includes(MARKER));
    },
  );

  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      emitDirectMsg(listeners[listeners.length - 1], "rx");
      await tick();
      const queuedNotify = pi.notifyLog.find((n) =>
        n.message.includes("[inter-agent] alice"),
      );
      assert.ok(queuedNotify, "queued inbound notify not shown");
      assert.ok(!queuedNotify!.message.includes(MARKER));
      assert.ok(queuedNotify!.message.includes("queued in mailbox"));
    },
  );
});

test("connection transitions notify the model without triggering a turn", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();

      const connected = connectionStatuses(pi);
      assert.equal(connected.length, 1);
      assert.equal(
        connected[0].message.content,
        'Connected to inter-agent message bus as "rx".',
      );
      assert.equal(connected[0].message.display, true);
      assert.deepEqual(connected[0].message.details, {
        status: "connected",
      });
      assert.ok(pi.renderers.has("inter-agent-status"));
      assert.deepEqual(connected[0].options, {
        triggerTurn: false,
        deliverAs: "followUp",
      });
      assert.deepEqual(pi.notifyLog, []);

      await cmd.handler("disconnect", pi.ctx);
      const statuses = connectionStatuses(pi);
      assert.equal(statuses.length, 2);
      assert.equal(
        statuses[1].message.content,
        "Disconnected from inter-agent message bus.",
      );
      assert.equal(statuses[1].message.display, true);
      assert.deepEqual(statuses[1].message.details, {
        status: "disconnected",
      });
      assert.deepEqual(statuses[1].options, {
        triggerTurn: false,
        deliverAs: "followUp",
      });
      assert.deepEqual(pi.notifyLog, []);

      // Repeating disconnect while already disconnected keeps the model quiet.
      await cmd.handler("disconnect", pi.ctx);
      assert.equal(connectionStatuses(pi).length, 2);
      assert.deepEqual(pi.notifyLog, []);
    },
  );
});

test("replacing a listener emits one completed connection status", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect a", pi.ctx);
      const listener1 = listeners[listeners.length - 1];
      listener1.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();

      await cmd.handler("connect b", pi.ctx);
      const listener2 = listeners[listeners.length - 1];
      listener2.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();

      const statuses = connectionStatuses(pi);
      assert.equal(statuses.length, 2);
      assert.equal(
        statuses[0].message.content,
        'Connected to inter-agent message bus as "a".',
      );
      assert.equal(
        statuses[1].message.content,
        'Connected to inter-agent message bus as "b".',
      );
      assert.deepEqual(pi.notifyLog, []);
    },
  );
});

test("unexpected listener exit notifies the model of disconnection", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();
      listener.exit(0);
      await tick();

      const statuses = connectionStatuses(pi);
      assert.equal(statuses.length, 2);
      assert.equal(statuses[1].message.customType, "inter-agent-status");
      assert.equal(
        statuses[1].message.content,
        "Disconnected from inter-agent message bus.",
      );
      assert.equal(statuses[1].message.display, true);
      assert.deepEqual(statuses[1].options, {
        triggerTurn: false,
        deliverAs: "followUp",
      });
    },
  );
});

test("unexpected listener failure uses one status notification", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();
      listener.exit(7);
      await tick();

      const statuses = connectionStatuses(pi);
      assert.equal(statuses.length, 2);
      assert.match(
        statuses[1].message.content,
        /^Disconnected from inter-agent message bus\. Listener exited: code 7\./,
      );
      assert.equal(
        pi.notifyLog.some((entry) => entry.message.includes("listener exited")),
        false,
      );
    },
  );
});

test("listener disconnect and reconnect preserve unread mailbox state", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener1 = listeners[listeners.length - 1];
      emitDirectMsg(listener1, "rx");
      await tick();

      // Disconnect, then reconnect within the same extension runtime.
      await cmd.handler("disconnect", pi.ctx);
      await cmd.handler("connect rx", pi.ctx);
      const listener2 = listeners[listeners.length - 1];
      listener2.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();

      // The mailbox was not cleared by stop/start: m1 remains unread until the
      // explicit read tool consumes it after reconnect.
      const read = (await readTool(pi).execute(
        "c",
        {},
        undefined,
        undefined,
        pi.ctx,
      )) as {
        details: { read: { id: string; body: string }[] };
      };
      assert.equal(read.details.read.length, 1);
      assert.equal(read.details.read[0].id, "m1");
      assert.equal(read.details.read[0].body, MARKER);
    },
  );
});

test("malformed frame followed by a valid frame both handle correctly", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      // A malformed frame (no msg_id) then a valid frame in the same chunk.
      listener.emitStdout(
        Buffer.concat([
          Buffer.from(
            JSON.stringify({ op: "msg", from_name: "x", text: "bad" }) + "\n",
          ),
          Buffer.from(
            JSON.stringify({
              op: "msg",
              msg_id: "good",
              from_name: "alice",
              text: MARKER,
            }) + "\n",
          ),
        ]).toString(),
      );
      await tick();

      const droppedNotify = pi.notifyLog.find((n) =>
        n.message.includes("without a valid msg_id"),
      );
      assert.ok(droppedNotify, "malformed frame did not warn");
      const read = (await readTool(pi).execute(
        "c",
        {},
        undefined,
        undefined,
        pi.ctx,
      )) as {
        details: { read: { id: string }[] };
      };
      assert.equal(read.details.read.length, 1);
      assert.equal(read.details.read[0].id, "good");
    },
  );
});

test("pending settlement before shutdown never flushes", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      // Hold a notice pending while active, then shut down before terminal
      // settlement can flush it.
      pi.ctx.idle = false;
      pi.ctx.pendingMessages = true;
      listener.emitStdout(
        JSON.stringify({
          op: "msg",
          msg_id: "m1",
          from_name: "alice",
          text: MARKER,
        }) + "\n",
      );
      await tick();
      await runHandler(pi, "agent_settled");
      // session_shutdown (in finally) runs after this; flush must not happen.
      await runHandler(pi, "session_shutdown");
      await tick(50);
      assert.ok(
        !pi.messages.some(
          (m) => m.message.customType === "inter-agent-mailbox",
        ),
      );
    },
  );
});

test("agent_settled flushes a pending queued notice at most once", async () => {
  await withEnv(
    { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
    async ({ pi, listeners }) => {
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      // Hold a notice pending while the agent is active.
      pi.ctx.idle = false;
      pi.ctx.pendingMessages = true;
      listener.emitStdout(
        JSON.stringify({
          op: "msg",
          msg_id: "m1",
          from_name: "alice",
          text: MARKER,
        }) + "\n",
      );
      await tick();
      assert.ok(
        !pi.messages.some(
          (m) => m.message.customType === "inter-agent-mailbox",
        ),
      );

      // Once fully settled, the handler flushes exactly one notice.
      pi.ctx.idle = true;
      pi.ctx.pendingMessages = false;
      await runHandler(pi, "agent_settled");
      await tick();
      const notices = pi.messages.filter(
        (m) => m.message.customType === "inter-agent-mailbox",
      );
      assert.equal(notices.length, 1);
      assert.ok(!JSON.stringify(notices[0].message.details).includes(MARKER));
      assert.equal(notices[0].options.triggerTurn, true);
    },
  );
});

// ── Same-process reload handoff wiring ──────────────────────────────────────

function emitMsg(
  listener: FakeChildProcess,
  msgId: string,
  fromName: string,
  body: string,
  extra: Record<string, unknown> = {},
): void {
  listener.emitStdout(
    JSON.stringify({
      op: "msg",
      msg_id: msgId,
      from_name: fromName,
      text: body,
      ...extra,
    }) + "\n",
  );
}

function mailboxNotices(pi: FakePi): RecordedMessage[] {
  return pi.messages.filter(
    (m) => m.message.customType === "inter-agent-mailbox",
  );
}

function connectionStatuses(pi: FakePi): RecordedMessage[] {
  return pi.messages.filter(
    (m) => m.message.customType === "inter-agent-status",
  );
}

test("ordinary command-connected identity reconnects exactly once across reload via transcript-restored state", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        const cmd = interAgentCommand(pi);
        await cmd.handler("connect rx", pi.ctx);
        const listener1 = listeners[listeners.length - 1];
        listener1.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        await tick();
        // Established command-connected identity: rx, durable in the transcript.
        const stateEntry = pi.branch.find(
          (e) => e.customType === "inter-agent-state",
        );
        assert.deepEqual(stateEntry?.data, {
          name: "rx",
          label: null,
          connected: true,
        });

        emitMsg(listener1, "d1", "alice", `${MARKER}-d1`, { to: "rx" });
        emitMsg(listener1, "b1", "bob", `${MARKER}-b1`);
        emitMsg(listener1, "c1", "cara", `${MARKER}-c1`, {
          channel: "updates",
        });
        await tick();
        const noticesBefore = mailboxNotices(pi).length;

        // No flag, so reconnect must come from transcript-restored connected state.
        pi.setFlagValue(undefined);
        const listenersBefore = listeners.length;
        // Reload: shutdown stops the OLD listener first (preserving durable
        // connected state), exports to the carrier, then clears the old mailbox.
        await runHandler(pi, "session_shutdown", { reason: "reload" }, pi.ctx);
        // The old listener process is gone; exactly one listener has been stopped.
        assert.equal(listeners.length, listenersBefore);
        assert.equal(listener1.signalCode, "SIGTERM");
        // Durable connected routing state was preserved for the reload start, so
        // the existing session_start connection branch reconnects.
        const reloadedState = pi.branch
          .slice()
          .reverse()
          .find((e) => e.customType === "inter-agent-state");
        assert.deepEqual(reloadedState?.data, {
          name: "rx",
          label: null,
          connected: true,
        });

        await runHandler(pi, "session_start", { reason: "reload" }, pi.ctx);
        await tick();
        // The matching reload start starts exactly one replacement listener (+1),
        // under the same routing name, with no overlap or second replacement.
        assert.equal(listeners.length, listenersBefore + 1);
        const listener2 = listeners[listeners.length - 1];
        listener2.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        await tick();
        const finalState = pi.branch
          .slice()
          .reverse()
          .find((e) => e.customType === "inter-agent-state");
        assert.deepEqual(finalState?.data, {
          name: "rx",
          label: null,
          connected: true,
        });

        // The old unread IDs survive in the mailbox; bodies surface only on read.
        const read = (await readTool(pi).execute(
          "c",
          {},
          undefined,
          undefined,
          pi.ctx,
        )) as {
          details: {
            read: {
              id: string;
              body: string;
              kind: string;
              channel?: string;
            }[];
          };
        };
        assert.equal(read.details.read.length, 3);
        assert.deepEqual(
          read.details.read.map((m) => m.id),
          ["d1", "b1", "c1"],
        );
        assert.equal(read.details.read[0].body, `${MARKER}-d1`);
        assert.equal(read.details.read[2].kind, "channel");
        assert.equal(read.details.read[2].channel, "updates");

        // No duplicate awareness turn for the notice that already entered context.
        assert.equal(mailboxNotices(pi).length, noticesBefore);
        // No manual reconnect was issued to satisfy reload continuity.
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
  }
});

test("startup --inter-agent flag identity reconnects exactly once across reload", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        // The flag takes precedence over transcript state; it is reapplied on every
        // session_start reason including reload.
        pi.setFlagValue("worker-a");
        await runHandler(pi, "session_start", {}, pi.ctx);
        await tick();
        const listener1 = listeners[listeners.length - 1];
        listener1.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        await tick();

        emitMsg(listener1, "f1", "alice", `${MARKER}-f1`, { to: "worker-a" });
        await tick();
        const noticesBefore = mailboxNotices(pi).length;

        const listenersBefore = listeners.length;
        await runHandler(pi, "session_shutdown", { reason: "reload" }, pi.ctx);
        assert.equal(listener1.signalCode, "SIGTERM");
        await runHandler(pi, "session_start", { reason: "reload" }, pi.ctx);
        await tick();
        // The flag branch reconnects exactly once under the same flag name.
        assert.equal(listeners.length, listenersBefore + 1);
        const listener2 = listeners[listeners.length - 1];
        listener2.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        await tick();
        const finalState = pi.branch
          .slice()
          .reverse()
          .find((e) => e.customType === "inter-agent-state");
        assert.deepEqual(finalState?.data, {
          name: "worker-a",
          label: null,
          connected: true,
        });

        const read = (await readTool(pi).execute(
          "c",
          {},
          undefined,
          undefined,
          pi.ctx,
        )) as { details: { read: { id: string; body: string }[] } };
        assert.equal(read.details.read.length, 1);
        assert.equal(read.details.read[0].id, "f1");
        assert.equal(read.details.read[0].body, `${MARKER}-f1`);
        assert.equal(mailboxNotices(pi).length, noticesBefore);
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
  }
});

test("mailbox restore itself does not start a listener or change routing identity", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        const cmd = interAgentCommand(pi);
        await cmd.handler("connect rx", pi.ctx);
        const listener1 = listeners[listeners.length - 1];
        listener1.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        emitMsg(listener1, "r1", "alice", `${MARKER}-r1`, { to: "rx" });
        await tick();
        const noticesBefore = mailboxNotices(pi).length;

        // Export a handoff, but simulate a reload start WITHOUT a transcript
        // reconnect path (no flag, durable state cleared) so restore alone runs.
        await runHandler(pi, "session_shutdown", { reason: "reload" }, pi.ctx);
        // Wipe the durable connected state and pin the flag off so the
        // session_start connection branch will not fire.
        pi.branch.length = 0;
        pi.setFlagValue(undefined);
        const listenersBefore = listeners.length;
        await runHandler(pi, "session_start", { reason: "reload" }, pi.ctx);
        await tick();
        // Restore consumed the carrier and reloaded unread; it started no listener.
        assert.equal(listeners.length, listenersBefore);
        assert.equal(carrier.slot, null);
        const read = (await readTool(pi).execute(
          "c",
          {},
          undefined,
          undefined,
          pi.ctx,
        )) as { details: { read: { id: string; body: string }[] } };
        assert.equal(read.details.read.length, 1);
        assert.equal(read.details.read[0].body, `${MARKER}-r1`);
        // Restore alone does not duplicate the already-delivered notice.
        assert.equal(mailboxNotices(pi).length, noticesBefore);
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
  }
});

test("reload restores exactly one body-free awareness notice for a pre-reload pending notice", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        const cmd = interAgentCommand(pi);
        await cmd.handler("connect rx", pi.ctx);
        const listener = listeners[listeners.length - 1];
        listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        await tick();

        // Hold a notice pending while the agent is active so no awareness turn
        // has entered context before reload.
        pi.ctx.idle = false;
        pi.ctx.pendingMessages = true;
        emitMsg(listener, "p1", "alice", `${MARKER}-p1`, { to: "rx" });
        await tick();
        assert.equal(mailboxNotices(pi).length, 0);

        await runHandler(pi, "session_shutdown", { reason: "reload" }, pi.ctx);
        // After reload, the new runtime is idle; the pending notice flushes once.
        pi.ctx.idle = true;
        pi.ctx.pendingMessages = false;
        await runHandler(pi, "session_start", { reason: "reload" }, pi.ctx);
        await tick();

        const notices = mailboxNotices(pi);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].options.triggerTurn, true);
        assert.ok(!JSON.stringify(notices[0].message.details).includes(MARKER));
        // The restored unread is still readable.
        const read = (await readTool(pi).execute(
          "c",
          {},
          undefined,
          undefined,
          pi.ctx,
        )) as { details: { read: { id: string; body: string }[] } };
        assert.equal(read.details.read[0].id, "p1");
        assert.equal(read.details.read[0].body, `${MARKER}-p1`);
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
  }
});

test("non-reload shutdown/start reasons clear the handoff and start empty", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        const cmd = interAgentCommand(pi);
        await cmd.handler("connect rx", pi.ctx);
        const listener = listeners[listeners.length - 1];
        listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        emitMsg(listener, "g1", "alice", `${MARKER}-g1`, { to: "rx" });
        await tick();

        // A terminated-process analog: shutdown reason "quit" clears the handoff,
        // and a later "resume" start (new process) does not restore it.
        await runHandler(pi, "session_shutdown", { reason: "quit" }, pi.ctx);
        assert.equal(carrier.slot, null);
        await runHandler(pi, "session_start", { reason: "resume" }, pi.ctx);
        await tick();
        assert.equal(carrier.slot, null);

        const read = (await readTool(pi).execute(
          "c",
          { ids: ["g1"] },
          undefined,
          undefined,
          pi.ctx,
        )) as { details: { read: unknown[]; missing: string[] } };
        assert.equal(read.details.read.length, 0);
        assert.deepEqual(read.details.missing, ["g1"]);
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
  }
});

test("reload handoff bodies never reach notices, settings entries, or diagnostics", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        const cmd = interAgentCommand(pi);
        await cmd.handler("connect rx", pi.ctx);
        const listener = listeners[listeners.length - 1];
        listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        emitMsg(listener, "s1", "alice", `${MARKER}-secret`, { to: "rx" });
        await tick();

        await runHandler(pi, "session_shutdown", { reason: "reload" }, pi.ctx);
        await runHandler(pi, "session_start", { reason: "reload" }, pi.ctx);
        await tick();

        // The carrier holds the body in process memory only; it never appears in
        // Pi messages, branch entries, or notifications.
        for (const recorded of pi.messages) {
          assert.ok(!JSON.stringify(recorded).includes(`${MARKER}-secret`));
        }
        for (const entry of pi.branch) {
          assert.ok(!JSON.stringify(entry).includes(`${MARKER}-secret`));
        }
        for (const n of pi.notifyLog) {
          assert.ok(!n.message.includes(`${MARKER}-secret`));
        }
        // The body surfaces only through an explicit read.
        const read = (await readTool(pi).execute(
          "c",
          {},
          undefined,
          undefined,
          pi.ctx,
        )) as { details: { read: { body: string }[] } };
        assert.equal(read.details.read[0].body, `${MARKER}-secret`);
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
  }
});

test("reload fails closed when stopListener cannot stop the old listener (hung child)", async () => {
  const carrier = new FakeCarrier();
  _setReloadCarrierForTest(carrier);
  _setStopTimeoutsForTest(10, 10);
  try {
    await withEnv(
      { project: { projectPath: process.cwd(), deliveryMode: "queued" } },
      async ({ pi, listeners }) => {
        const cmd = interAgentCommand(pi);
        await cmd.handler("connect rx", pi.ctx);
        const listener1 = listeners[listeners.length - 1];
        listener1.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
        await tick();
        emitMsg(listener1, "h1", "alice", `${MARKER}-hung`, { to: "rx" });
        await tick();
        const noticesBefore = mailboxNotices(pi).length;

        // Make the child ignore kill so stopListener times out and returns false.
        listener1.hangOnKill = true;
        pi.setFlagValue(undefined);
        const listenersBefore = listeners.length;

        // Reload shutdown: stop times out → no handoff exported, carrier cleared,
        // durable connected state cleared so matching start cannot reconnect.
        await runHandler(pi, "session_shutdown", { reason: "reload" }, pi.ctx);
        assert.equal(carrier.slot, null); // no body handoff
        const failState = pi.branch
          .slice()
          .reverse()
          .find((e) => e.customType === "inter-agent-state");
        assert.deepEqual(failState?.data, {
          name: "rx",
          label: null,
          connected: false,
        });

        // Matching reload start: no replacement listener (durable state cleared),
        // no handoff to restore, old unread unavailable to the new runtime.
        await runHandler(pi, "session_start", { reason: "reload" }, pi.ctx);
        await tick();
        assert.equal(listeners.length, listenersBefore); // no replacement started
        assert.equal(carrier.slot, null);

        const read = (await readTool(pi).execute(
          "c",
          { ids: ["h1"] },
          undefined,
          undefined,
          pi.ctx,
        )) as { details: { read: unknown[]; missing: string[] } };
        assert.equal(read.details.read.length, 0);
        assert.deepEqual(read.details.missing, ["h1"]);

        // No body disclosed in notices, diagnostics, or messages.
        for (const recorded of pi.messages) {
          assert.ok(!JSON.stringify(recorded).includes(`${MARKER}-hung`));
        }
        for (const entry of pi.branch) {
          assert.ok(!JSON.stringify(entry).includes(`${MARKER}-hung`));
        }
        for (const n of pi.notifyLog) {
          assert.ok(!n.message.includes(`${MARKER}-hung`));
        }
        // No new awareness notice for the failed reload.
        assert.equal(mailboxNotices(pi).length, noticesBefore);

        // Let the finally's shutdown stop instantly instead of timing out again.
        listener1.hangOnKill = false;
        listener1.kill("SIGTERM");
      },
    );
  } finally {
    _setReloadCarrierForTest(null);
    _setStopTimeoutsForTest(null, null);
  }
});

test("project TLS/data config overrides conflicting globals and propagates to listener env only", async () => {
  const secretValue = "pi-tls-propagation-test-secret";
  // Global settings carry conflicting values for every TLS/data field; the
  // project settings must override all of them, and the listener env must
  // carry exactly the project-resolved values.
  await withEnv(
    {
      global: {
        dataDir: "global-state",
        tls: false,
        tlsCert: "global-certs/cert.pem",
        tlsKey: "global-certs/key.pem",
        secret: "global-secret-must-not-appear",
      },
      project: {
        dataDir: "state",
        tls: true,
        tlsCert: "certs/tls-cert.pem",
        tlsKey: "certs/tls-key.pem",
        secret: secretValue,
      },
    },
    async ({ pi, listeners }) => {
      const projectSettingsDir = join(process.cwd(), ".pi");
      const cmd = interAgentCommand(pi);
      await cmd.handler("connect rx", pi.ctx);
      const listener = listeners[listeners.length - 1];
      const env = listener.spawnEnv as Record<string, string | undefined>;

      // Project values override the conflicting globals; paths resolve
      // relative to the project settings file and are absolute.
      assert.equal(env.INTER_AGENT_TLS, "true");
      assert.equal(env.INTER_AGENT_DATA_DIR, join(projectSettingsDir, "state"));
      assert.equal(
        env.INTER_AGENT_TLS_CERT,
        join(projectSettingsDir, "certs", "tls-cert.pem"),
      );
      assert.equal(
        env.INTER_AGENT_TLS_KEY,
        join(projectSettingsDir, "certs", "tls-key.pem"),
      );
      assert.ok(isAbsolute(env.INTER_AGENT_DATA_DIR!));
      assert.ok(isAbsolute(env.INTER_AGENT_TLS_CERT!));
      assert.ok(isAbsolute(env.INTER_AGENT_TLS_KEY!));
      assert.equal(env.INTER_AGENT_SECRET, secretValue);
      // The global values did not leak through.
      assert.notEqual(env.INTER_AGENT_TLS, "false");
      assert.notEqual(
        env.INTER_AGENT_DATA_DIR,
        join(projectSettingsDir, "global-state"),
      );
      assert.ok(!env.INTER_AGENT_TLS_CERT?.includes("global-certs"));
      assert.ok(!env.INTER_AGENT_TLS_KEY?.includes("global-certs"));
      assert.notEqual(env.INTER_AGENT_SECRET, "global-secret-must-not-appear");

      // The listener command carries only the connect subcommand and name;
      // TLS paths and the secret are environment-only, never argv.
      assert.deepEqual(listener.spawnArgs, ["connect", "rx"]);
      for (const arg of listener.spawnArgs as string[]) {
        assert.ok(!arg.includes(secretValue));
        assert.ok(!arg.includes("tls-cert.pem"));
        assert.ok(!arg.includes("tls-key.pem"));
        assert.ok(!arg.includes("global-secret-must-not-appear"));
      }
      // Secret absent from notifications/diagnostics emitted so far.
      for (const n of pi.notifyLog) {
        assert.ok(!n.message.includes(secretValue));
        assert.ok(!n.message.includes("global-secret-must-not-appear"));
      }
    },
  );
});
