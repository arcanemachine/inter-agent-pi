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
import { join } from "node:path";

import ext, {
  _setControlHelperTimeoutsForTest,
  _setSpawnForTest,
  _setReloadCarrierForTest,
} from "../../src/index.js";

// ── Fake Pi runtime ─────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

interface RecordedMessage {
  message: { customType: string; content: string; details: unknown };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

interface BranchEntry {
  type: string;
  customType: string;
  data: unknown;
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killSignals: NodeJS.Signals[] = [];
  ignoreSigterm = false;
  // The extension writes the control-send request here.
  stdinEnded = "";
  [key: string]: unknown;

  stdin = {
    end: (data?: string | Buffer): void => {
      this.stdinEnded = data ? Buffer.from(data as never).toString("utf8") : "";
    },
    write: (): boolean => true,
  } as unknown as NodeJS.WritableStream;

  emitStdout(line: string): void {
    this.stdout.emit("data", Buffer.from(line));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killSignals.push(signal);
    if (signal === "SIGTERM" && this.ignoreSigterm) return false;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }

  unref(): void {
    // No-op.
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
  signal: AbortSignal | undefined = undefined;
  sessionId = "control-session-1";

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

  abort(): void {
    // Fake: recorded through the ctx instance by tests that need it.
  }

  shutdown(): void {
    // Fake.
  }
}

class FakePi {
  readonly commands = new Map<string, { handler: Handler }>();
  readonly tools = new Map<string, { execute: Handler }>();
  readonly renderers = new Map<string, unknown>();
  readonly flags = new Map<string, unknown>();
  readonly flagValues = new Map<string, unknown>();
  readonly handlers = new Map<string, Handler[]>();
  readonly messages: RecordedMessage[] = [];
  readonly branch: BranchEntry[] = [];
  readonly notifyLog: { message: string; type: string }[] = [];
  readonly userMessages: { text: string; deliverAs: unknown }[] = [];
  readonly ctx: FakeCtx;

  constructor() {
    this.ctx = new FakeCtx(this.branch, this.notifyLog);
  }

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, options: { handler: Handler }): void {
    this.commands.set(name, { handler: options.handler });
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

  getFlag(name: string): unknown {
    return this.flagValues.get(name);
  }

  setFlagValue(name: string, value: unknown): void {
    this.flagValues.set(name, value);
  }

  sendMessage(
    message: { customType: string; content: string; details: unknown },
    options: { triggerTurn?: boolean; deliverAs?: string },
  ): void {
    this.messages.push({ message, options });
  }

  sendUserMessage(
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void {
    this.userMessages.push({ text, deliverAs: options?.deliverAs });
  }

  appendEntry(customType: string, data: unknown): void {
    this.branch.push({ type: "custom", customType, data });
  }
}

// ── Environment + spawn fakes ───────────────────────────────────────────────

function setupEnv(): { pi: FakePi; home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "ia-ctl-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-ctl-cwd-"));
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
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ interAgent: { projectPath: cwd } }),
  );
  return { pi: new FakePi(), home, cwd };
}

interface Spawned {
  proc: FakeChildProcess;
  cmd: string;
  args: string[];
}

function withExtension(
  fn: (api: {
    pi: FakePi;
    listeners: FakeChildProcess[];
    controlSends: Spawned[];
  }) => Promise<void>,
  options: { controlSendIgnoreSigterm?: boolean } = {},
): Promise<void> {
  return (async () => {
    const env = setupEnv();
    const oldHome = process.env.HOME;
    const oldCwd = process.cwd();
    process.env.HOME = env.home;
    process.chdir(env.cwd);
    const listeners: FakeChildProcess[] = [];
    const controlSends: Spawned[] = [];
    _setSpawnForTest(((cmd: string, args: string[], spawnOptions: unknown) => {
      const record = (proc: FakeChildProcess): FakeChildProcess => {
        proc.spawnCmd = cmd;
        proc.spawnArgs = args;
        proc.spawnEnv = (
          spawnOptions as
            | { env?: Record<string, string | undefined> }
            | undefined
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
      if (args[0] === "control-send") {
        const proc = record(new FakeChildProcess());
        proc.ignoreSigterm = options.controlSendIgnoreSigterm === true;
        controlSends.push({ proc, cmd, args });
        if (!options.controlSendIgnoreSigterm) {
          queueMicrotask(() => {
            proc.emitStdout(
              JSON.stringify({ op: "custom_ok", submitted: true }) + "\n",
            );
            proc.exit(0);
          });
        }
        return proc;
      }
      const proc = record(new FakeChildProcess());
      queueMicrotask(() => proc.exit(0));
      return proc;
    }) as never);

    try {
      ext(env.pi as never);
      await runHandler(env.pi, "session_start", {}, env.pi.ctx);
      await fn({ pi: env.pi, listeners, controlSends });
    } finally {
      await runHandler(env.pi, "session_shutdown");
      process.env.HOME = oldHome;
      _setSpawnForTest(null);
      _setReloadCarrierForTest(null);
      _setControlHelperTimeoutsForTest(null, null);
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
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler(...args);
  }
}

function interAgentCommand(pi: FakePi): { handler: Handler } {
  const cmd = pi.commands.get("inter-agent");
  if (!cmd) throw new Error("inter-agent command not registered");
  return cmd;
}

function controlRequestPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "request",
    id: "ctl-1",
    command: "state",
    args: {},
    ...overrides,
  };
}

function emitControlFrame(
  listener: FakeChildProcess,
  payload: unknown,
  fromName = "leader",
): void {
  listener.emitStdout(
    JSON.stringify({
      op: "msg",
      msg_id: `m-${Math.random()}`,
      from_name: fromName,
      custom_type: "pi.control.v1",
      payload,
      to: "worker-a",
    }) + "\n",
  );
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("registers the allow-control-by startup flag", async () => {
  await withExtension(async ({ pi }) => {
    const flag = pi.flags.get("allow-control-by");
    assert.ok(flag, "allow-control-by flag not registered");
    assert.equal(
      (flag as { type?: string }).type,
      "string",
      "allow-control-by must be a string flag",
    );
  });
});

test("invalid allow-control-by fails closed with a bounded user error", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const cmd = interAgentCommand(pi);
    pi.setFlagValue("allow-control-by", "leader,,bogus_Name");
    await runHandler(pi, "session_start", {}, pi.ctx);
    const errorNotify = pi.notifyLog
      .slice()
      .reverse()
      .find(
        (n) => n.type === "error" && n.message.includes("allow-control-by"),
      );
    assert.ok(errorNotify, "invalid allowlist did not surface a bounded error");

    // Control is disabled: a request from an allowlisted-looking name is
    // rejected as unauthorized and never reaches Pi APIs.
    await cmd.handler("connect worker-a", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    await tick();
    emitControlFrame(listener, controlRequestPayload(), "leader");
    await tick();
    assert.equal(pi.userMessages.length, 0);
    // The rejection response was submitted via control-send to the sender.
    const lastSend = controlSends[controlSends.length - 1];
    assert.ok(lastSend, "no rejection response submitted");
    const stdinJson = JSON.parse(lastSend.proc.stdinEnded);
    assert.equal(stdinJson.custom_type, "pi.control.v1");
    assert.equal(stdinJson.to, "leader");
    assert.equal(stdinJson.payload.phase, "rejected");
    assert.equal(stdinJson.payload.error.code, "unauthorized");
    // No mailbox entry or notice was produced by the control frame.
    assert.equal(
      pi.messages.filter((m) => m.message.customType === "inter-agent-mailbox")
        .length,
      0,
    );
  });
});

test("control requests never enter the ordinary mailbox and respond via control-send", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const cmd = interAgentCommand(pi);
    pi.setFlagValue("allow-control-by", "leader");
    await runHandler(pi, "session_start", {}, pi.ctx);
    await cmd.handler("connect worker-a", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    await tick();

    emitControlFrame(
      listener,
      controlRequestPayload({ id: "st-1", command: "state" }),
      "leader",
    );
    await tick();
    // Exactly two responses (accepted, settled) submitted for the state request.
    const sends = controlSends.filter(
      (s) => JSON.parse(s.proc.stdinEnded).payload.id === "st-1",
    );
    assert.equal(sends.length, 2);
    const phases = sends.map(
      (s) => JSON.parse(s.proc.stdinEnded).payload.phase,
    );
    assert.deepEqual(phases, ["accepted", "settled"]);
    // The settled state payload is privacy-safe.
    const settled = JSON.parse(sends[1].proc.stdinEnded).payload;
    assert.equal(settled.data.name, "worker-a");
    assert.equal(settled.data.controlEnabled, true);
    assert.equal(settled.data.allowlistCount, 1);
    assert.equal(settled.data.activeRequest, null);
    // No mailbox notice and no empty ordinary message entry.
    assert.equal(
      pi.messages.filter((m) => m.message.customType === "inter-agent-mailbox")
        .length,
      0,
    );
    const readTool = pi.tools.get("inter_agent_read_messages");
    assert.ok(readTool);
    const result = (await readTool.execute(
      "c",
      {},
      undefined,
      undefined,
      pi.ctx,
    )) as { details: { read: unknown[] } };
    assert.equal(result.details.read.length, 0);
  });
});

test("unknown custom message types warn and never create empty mailbox entries", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const cmd = interAgentCommand(pi);
    await cmd.handler("connect worker-a", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    listener.emitStdout(
      JSON.stringify({
        op: "msg",
        msg_id: "u1",
        from_name: "peer",
        custom_type: "x.other.v1",
        payload: { k: "v" },
        to: "worker-a",
      }) + "\n",
    );
    await tick();
    const customWarn = pi.notifyLog.find((n) =>
      n.message.includes("ignored unknown custom message type"),
    );
    assert.ok(customWarn, "unknown custom frame did not warn");
    assert.ok(
      controlSends.length === 0,
      "unknown custom frame must not respond",
    );
    assert.equal(
      pi.messages.filter((m) => m.message.customType === "inter-agent-mailbox")
        .length,
      0,
    );
  });
});

test("ordinary non-custom frames still queue in the mailbox", async () => {
  await withExtension(async ({ pi, listeners }) => {
    const cmd = interAgentCommand(pi);
    await cmd.handler("connect worker-a", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    listener.emitStdout(
      JSON.stringify({
        op: "msg",
        msg_id: "m1",
        from_name: "alice",
        text: "hello body",
        to: "worker-a",
      }) + "\n",
    );
    await tick();
    const readTool = pi.tools.get("inter_agent_read_messages");
    const result = (await readTool.execute(
      "c",
      {},
      undefined,
      undefined,
      pi.ctx,
    )) as { details: { read: { id: string; body: string }[] } };
    assert.equal(result.details.read.length, 1);
    assert.equal(result.details.read[0].id, "m1");
    assert.equal(result.details.read[0].body, "hello body");
  });
});

test("responses queue while the listener is unavailable and flush on welcome", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const cmd = interAgentCommand(pi);
    pi.setFlagValue("allow-control-by", "leader");
    await runHandler(pi, "session_start", {}, pi.ctx);
    await cmd.handler("connect worker-a", pi.ctx);
    const listener = listeners[listeners.length - 1];
    // A control request arrives before the welcome/bridge readiness.
    emitControlFrame(listener, controlRequestPayload({ id: "q-1" }), "leader");
    await tick();
    assert.equal(controlSends.length, 0, "responses must queue before welcome");

    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    await tick();
    const sends = controlSends.filter(
      (s) => JSON.parse(s.proc.stdinEnded).payload.id === "q-1",
    );
    assert.equal(sends.length, 2, "queued responses flush after welcome");
    assert.deepEqual(
      sends.map((s) => JSON.parse(s.proc.stdinEnded).payload.phase),
      ["accepted", "settled"],
    );
  });
});

test("registers the controller tool and grouped control command", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const tool = pi.tools.get("inter_agent_control");
    assert.ok(tool, "inter_agent_control tool not registered");
    const command = interAgentCommand(pi);
    pi.setFlagValue("allow-control-by", "leader");
    await runHandler(pi, "session_start", {}, pi.ctx);
    await command.handler("connect leader", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    await tick();

    const toolPromise = tool.execute(
      "call-1",
      {
        target: "worker-a",
        command: "prompt",
        text: "hello",
        requestId: "tool-1",
      },
      undefined,
      undefined,
      pi.ctx,
    ) as Promise<{ details: { requestId: string; phase: string } }>;
    await tick();
    const submitted = controlSends[controlSends.length - 1];
    assert.ok(submitted, "controller request was not submitted");
    const request = JSON.parse(submitted.proc.stdinEnded);
    assert.equal(request.to, "worker-a");
    assert.equal(request.payload.id, "tool-1");
    assert.equal(request.payload.args.text, "hello");

    emitControlFrame(
      listener,
      {
        kind: "response",
        id: "tool-1",
        command: "prompt",
        phase: "accepted",
        sequence: 0,
        data: {},
        error: null,
      },
      "worker-a",
    );
    const accepted = await toolPromise;
    assert.equal(accepted.details.requestId, "tool-1");
    assert.equal(accepted.details.phase, "accepted");

    emitControlFrame(
      listener,
      {
        kind: "response",
        id: "tool-1",
        command: "prompt",
        phase: "settled",
        sequence: 2,
        data: { text: "done" },
        error: null,
      },
      "worker-a",
    );
    await tick();
    const result = pi.messages.find(
      (message) => message.message.customType === "inter-agent-control-result",
    );
    assert.ok(
      result,
      "terminal control result did not enter controller context",
    );
    assert.ok(result.message.content.includes("done"));
    assert.equal(result.options.triggerTurn, true);

    const commandPromise = command.handler(
      "control worker-a state",
      pi.ctx,
    ) as Promise<void>;
    await tick();
    const stateSend = controlSends[controlSends.length - 1];
    assert.equal(
      JSON.parse(stateSend.proc.stdinEnded).payload.command,
      "state",
    );
    emitControlFrame(
      listener,
      {
        kind: "response",
        id: JSON.parse(stateSend.proc.stdinEnded).payload.id,
        command: "state",
        phase: "accepted",
        sequence: 0,
        data: {},
        error: null,
      },
      "worker-a",
    );
    emitControlFrame(
      listener,
      {
        kind: "response",
        id: JSON.parse(stateSend.proc.stdinEnded).payload.id,
        command: "state",
        phase: "settled",
        sequence: 1,
        data: { lifecycle: "idle" },
        error: null,
      },
      "worker-a",
    );
    await commandPromise;
    assert.ok(
      pi.notifyLog.some((entry) => entry.message.includes("Control request")),
    );
  });
});

test("hung controller helper escalates to SIGKILL and cleans listeners", async () => {
  await withExtension(
    async ({ pi, listeners, controlSends }) => {
      _setControlHelperTimeoutsForTest(5, 5);
      const command = interAgentCommand(pi);
      await command.handler("connect leader", pi.ctx);
      const listener = listeners[listeners.length - 1];
      listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
      await tick();
      const tool = pi.tools.get("inter_agent_control");
      assert.ok(tool);
      await assert.rejects(
        () =>
          tool.execute(
            "hung-call",
            { target: "worker-a", command: "state", requestId: "hung-child" },
            undefined,
            undefined,
            pi.ctx,
          ) as Promise<unknown>,
        /unknown/,
      );
      const helper = controlSends[controlSends.length - 1].proc;
      assert.deepEqual(helper.killSignals, ["SIGTERM", "SIGKILL"]);
      assert.equal(helper.stdout.listenerCount("data"), 0);
      assert.equal(helper.stderr.listenerCount("data"), 0);
      assert.equal(helper.listenerCount("close"), 0);
      assert.equal(helper.listenerCount("error"), 0);
    },
    { controlSendIgnoreSigterm: true },
  );
});

test("controller command rejects missing text without sending a second identity", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const command = interAgentCommand(pi);
    await command.handler("connect leader", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    await tick();
    await command.handler("control worker-a prompt", pi.ctx);
    assert.ok(
      pi.notifyLog.some(
        (entry) =>
          entry.type === "error" && entry.message.includes("requires text"),
      ),
    );
    assert.equal(controlSends.length, 0);
    assert.equal(listeners.length, 1);
  });
});

test("a prompt uses released sendUserMessage with no delivery override", async () => {
  await withExtension(async ({ pi, listeners, controlSends }) => {
    const cmd = interAgentCommand(pi);
    pi.setFlagValue("allow-control-by", "leader");
    await runHandler(pi, "session_start", {}, pi.ctx);
    await cmd.handler("connect worker-a", pi.ctx);
    const listener = listeners[listeners.length - 1];
    listener.emitStdout(JSON.stringify({ op: "welcome" }) + "\n");
    await tick();

    emitControlFrame(
      listener,
      controlRequestPayload({
        id: "p-1",
        command: "prompt",
        args: { text: "injected prompt" },
      }),
      "leader",
    );
    await tick();
    assert.deepEqual(pi.userMessages, [
      { text: "injected prompt", deliverAs: undefined },
    ]);

    // Only the released lifecycle event starts the shared activity window.
    await runHandler(pi, "agent_start");
    // The run settles: agent_settled finalizes the op with the final text.
    await runHandler(pi, "agent_settled");
    // No assistant message was observed in this fake, so the result is
    // resultUnavailable rather than fabricated text.
    const settled = controlSends
      .map((s) => JSON.parse(s.proc.stdinEnded).payload)
      .find((p) => p.id === "p-1" && p.phase === "settled");
    assert.ok(settled, "no settled response emitted");
    assert.equal(settled.data.resultUnavailable, true);
    assert.equal(settled.data.text, undefined);
  });
});
