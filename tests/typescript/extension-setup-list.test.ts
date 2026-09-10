import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import ext, { _setSpawnForTest } from "../../src/index.js";

interface UserMessage {
  text: string;
  options: { expandPromptTemplates?: boolean; deliverAs?: string };
}

type Handler = (...args: unknown[]) => unknown;

type FakeProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  kill: () => void;
};

class FakeCtx {
  readonly sessionManager = {
    getBranch: () => [],
    getSessionId: () => "setup-list-session",
  };
  readonly notifications: { message: string; type: string }[] = [];
  readonly ui = {
    notify: (message: string, type = "info") =>
      this.notifications.push({ message, type }),
    confirm: async (_title: string, message: string) => {
      this.confirmations.push(message);
      return this.confirmResult;
    },
    setStatus: (_key: string, _text: string | undefined) => {},
  };
  readonly confirmations: string[] = [];
  confirmResult = false;

  isIdle(): boolean {
    return true;
  }

  hasPendingMessages(): boolean {
    return false;
  }

  abort(): void {}

  shutdown(): void {}
}

class FakePi {
  readonly commands = new Map<string, { handler: Handler }>();
  readonly handlers = new Map<string, Handler[]>();
  readonly tools: {
    name: string;
    execute: Handler;
    renderCall?: (...args: unknown[]) => unknown;
    renderResult?: (...args: unknown[]) => unknown;
  }[] = [];
  readonly sentMessages: unknown[][] = [];
  readonly ctx = new FakeCtx();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, options: { handler: Handler }): void {
    this.commands.set(name, options);
  }

  registerTool(tool: {
    name: string;
    execute: Handler;
    renderCall?: (...args: unknown[]) => unknown;
    renderResult?: (...args: unknown[]) => unknown;
  }): void {
    this.tools.push(tool);
  }

  registerMessageRenderer(_name: string, _renderer: unknown): void {}

  registerFlag(_name: string, _options: unknown): void {}

  getFlag(_name: string): unknown {
    return undefined;
  }

  getCommands(): never[] {
    return [];
  }

  sendMessage(...args: unknown[]): void {
    this.sentMessages.push(args);
  }

  sendUserMessage(
    _text: string,
    _options: { expandPromptTemplates?: boolean; deliverAs?: string } = {},
  ): void {}

  appendEntry(..._args: unknown[]): void {}
}

async function runHandlers(pi: FakePi, event: string): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler({}, pi.ctx);
  }
}

async function withoutHelperOverride(fn: () => Promise<void>): Promise<void> {
  const oldOverride = process.env.INTER_AGENT_PI_HELPER;
  delete process.env.INTER_AGENT_PI_HELPER;
  try {
    await fn();
  } finally {
    if (oldOverride === undefined) delete process.env.INTER_AGENT_PI_HELPER;
    else process.env.INTER_AGENT_PI_HELPER = oldOverride;
  }
}

function command(pi: FakePi): { handler: Handler } {
  const registered = pi.commands.get("inter-agent");
  if (!registered) throw new Error("inter-agent command not registered");
  return registered;
}

function createHelperScripts(home: string): string {
  const venv = join(home, ".pi", "agent", "inter-agent", "venv");
  const bin = join(venv, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(venv, "pyvenv.cfg"), "home = /tmp/python\n");
  writeFileSync(join(bin, "python"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "python"), 0o755);
  for (const name of [
    "inter-agent-pi",
    "inter-agent-connect",
    "inter-agent-server",
  ]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return bin;
}

function fakeProcess(
  commandName: string,
  args: string[],
  calls: { command: string; args: string[] }[],
  home: string,
  options: { verboseVersion?: boolean; kills?: number[] } = {},
): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: () => {} };
  proc.kill = () => {
    options.kills?.push(1);
  };
  calls.push({ command: commandName, args });

  queueMicrotask(() => {
    const normalizedArgs = args[0] === "-I" ? args.slice(1) : args;
    const commandArgs =
      normalizedArgs[0] === "-m" &&
      normalizedArgs[1] === "pip" &&
      normalizedArgs[2] === "--isolated"
        ? [normalizedArgs[0], normalizedArgs[1], ...normalizedArgs.slice(3)]
        : normalizedArgs;
    if (commandArgs[0] === "--version") {
      const version = `Python 3.12.8\n${options.verboseVersion ? "x".repeat(20_000) : ""}`;
      proc.stdout.emit("data", Buffer.from(version));
    }
    if (normalizedArgs[0] === "-m" && normalizedArgs[1] === "venv") {
      const bin = join(home, ".pi", "agent", "inter-agent", "venv", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(home, ".pi", "agent", "inter-agent", "venv", "pyvenv.cfg"),
        "home = /tmp/python\n",
      );
      writeFileSync(join(bin, "python"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "python"), 0o755);
    }
    if (
      commandArgs[0] === "-m" &&
      commandArgs[1] === "pip" &&
      commandArgs[2] === "install"
    ) {
      createHelperScripts(home);
    }
    proc.emit("close", 0);
  });
  return proc;
}

function renderText(component: {
  render: (width: number) => string[];
}): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

async function withExtension(
  home: string,
  cwd: string,
  fn: (pi: FakePi) => Promise<void>,
): Promise<void> {
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  process.env.HOME = home;
  process.env.PATH = join(home, "empty-bin");
  mkdirSync(process.env.PATH, { recursive: true });
  process.chdir(cwd);
  const pi = new FakePi();
  try {
    ext(pi as never);
    await runHandlers(pi, "session_start");
    await fn(pi);
  } finally {
    await runHandlers(pi, "session_shutdown");
    _setSpawnForTest(null);
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    process.chdir(oldCwd);
  }
}

test("setup cancellation performs no subprocess work", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-cancel-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-cancel-cwd-"));
  let spawnCalls = 0;
  _setSpawnForTest((() => {
    spawnCalls += 1;
    throw new Error("setup must not spawn after cancellation");
  }) as never);
  try {
    await withExtension(home, cwd, async (pi) => {
      await command(pi).handler("setup", pi.ctx);
      assert.equal(spawnCalls, 0);
      assert.match(
        pi.ctx.notifications[pi.ctx.notifications.length - 1]?.message ?? "",
        /setup cancelled/,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approved setup uses compatible pip source and verifies helpers", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-approved-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-approved-cwd-"));
  const calls: { command: string; args: string[] }[] = [];
  try {
    _setSpawnForTest(((commandName: string, args: string[]) =>
      fakeProcess(commandName, args, calls, home)) as never);
    await withExtension(home, cwd, async (pi) => {
      pi.ctx.confirmResult = true;
      await command(pi).handler("setup", pi.ctx);
      assert.match(pi.ctx.confirmations[0] ?? "", /inter-agent-pi~=0\.3\.1/);
      assert.deepEqual(
        calls.map((call) => call.args),
        [
          ["-I", "--version"],
          [
            "-I",
            "-m",
            "venv",
            join(home, ".pi", "agent", "inter-agent", "venv"),
          ],
          ["-I", "-m", "pip", "--isolated", "--version"],
          [
            "-I",
            "-m",
            "pip",
            "--isolated",
            "install",
            "--upgrade",
            "--no-cache-dir",
            "--",
            "inter-agent-pi~=0.3.1",
          ],
        ],
      );
      assert.match(
        pi.ctx.notifications[pi.ctx.notifications.length - 1]?.message ?? "",
        /managed helper environment ready/,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approved setup repairs a verified incomplete managed venv", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-repair-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-repair-cwd-"));
  const venv = join(home, ".pi", "agent", "inter-agent", "venv");
  const calls: { command: string; args: string[] }[] = [];
  try {
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), "home = /tmp/python\n");
    writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(venv, "bin", "python"), 0o755);
    _setSpawnForTest(((commandName: string, args: string[]) =>
      fakeProcess(commandName, args, calls, home)) as never);
    await withExtension(home, cwd, async (pi) => {
      pi.ctx.confirmResult = true;
      await command(pi).handler("setup", pi.ctx);
      assert.ok(calls.some((call) => call.args.includes("--clear")));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("setup refuses a managed path through a symlinked parent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-symlink-home-"));
  const outside = mkdtempSync(join(tmpdir(), "ia-setup-symlink-outside-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-symlink-cwd-"));
  let spawnCalls = 0;
  try {
    mkdirSync(join(outside, "agent", "inter-agent", "venv"), {
      recursive: true,
    });
    symlinkSync(outside, join(home, ".pi"), "dir");
    _setSpawnForTest((() => {
      spawnCalls += 1;
      throw new Error("unsafe setup must not spawn");
    }) as never);
    await withExtension(home, cwd, async (pi) => {
      await command(pi).handler("setup", pi.ctx);
      assert.equal(spawnCalls, 0);
      const failure = pi.ctx.notifications[pi.ctx.notifications.length - 1];
      assert.match(failure?.message ?? "", /no files were changed/);
      assert.match(failure?.message ?? "", /\/inter-agent doctor/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit setup source and interpreter are not disclosed in approval text", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-override-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-override-cwd-"));
  const calls: { command: string; args: string[] }[] = [];
  const oldPython = process.env.INTER_AGENT_PI_SETUP_PYTHON;
  const oldSource = process.env.INTER_AGENT_PI_SETUP_SOURCE;
  process.env.INTER_AGENT_PI_SETUP_PYTHON = "/tmp/custom-python";
  process.env.INTER_AGENT_PI_SETUP_SOURCE =
    "https://user:secret@example.invalid/inter-agent-pi.whl";
  try {
    _setSpawnForTest(((commandName: string, args: string[]) =>
      fakeProcess(commandName, args, calls, home)) as never);
    await withExtension(home, cwd, async (pi) => {
      pi.ctx.confirmResult = true;
      await command(pi).handler("setup", pi.ctx);
      assert.equal(calls[0]?.command, "/tmp/custom-python");
      assert.match(
        pi.ctx.confirmations[0] ?? "",
        /INTER_AGENT_PI_SETUP_SOURCE/,
      );
      assert.doesNotMatch(
        pi.ctx.confirmations[0] ?? "",
        /example\.invalid|inter-agent-pi\.whl|user:secret/,
      );
    });
  } finally {
    if (oldPython === undefined) delete process.env.INTER_AGENT_PI_SETUP_PYTHON;
    else process.env.INTER_AGENT_PI_SETUP_PYTHON = oldPython;
    if (oldSource === undefined) delete process.env.INTER_AGENT_PI_SETUP_SOURCE;
    else process.env.INTER_AGENT_PI_SETUP_SOURCE = oldSource;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("setup retains doctor guidance for a higher-precedence helper override", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-shadow-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-shadow-cwd-"));
  const calls: { command: string; args: string[] }[] = [];
  const oldOverride = process.env.INTER_AGENT_PI_HELPER;
  process.env.INTER_AGENT_PI_HELPER = "/tmp/higher-precedence-helper";
  try {
    _setSpawnForTest(((commandName: string, args: string[]) =>
      fakeProcess(commandName, args, calls, home)) as never);
    await withExtension(home, cwd, async (pi) => {
      pi.ctx.confirmResult = true;
      await command(pi).handler("setup", pi.ctx);
      assert.match(pi.ctx.confirmations[0] ?? "", /INTER_AGENT_PI_HELPER/);
      const result = pi.ctx.notifications[pi.ctx.notifications.length - 1];
      assert.match(result?.message ?? "", /\/inter-agent doctor/);
      assert.equal(result?.type, "warning");
    });
  } finally {
    if (oldOverride === undefined) delete process.env.INTER_AGENT_PI_HELPER;
    else process.env.INTER_AGENT_PI_HELPER = oldOverride;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("verbose setup output is discarded without killing a valid process", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-output-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-output-cwd-"));
  const calls: { command: string; args: string[] }[] = [];
  const kills: number[] = [];
  try {
    _setSpawnForTest(((commandName: string, args: string[]) =>
      fakeProcess(commandName, args, calls, home, {
        verboseVersion: true,
        kills,
      })) as never);
    await withExtension(home, cwd, async (pi) => {
      pi.ctx.confirmResult = true;
      await command(pi).handler("setup", pi.ctx);
      assert.equal(kills.length, 0);
      assert.match(
        pi.ctx.notifications[pi.ctx.notifications.length - 1]?.message ?? "",
        /managed helper environment ready/,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("connect recommends setup for a missing managed runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-connect-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-connect-cwd-"));
  try {
    await withoutHelperOverride(() =>
      withExtension(home, cwd, async (pi) => {
        await command(pi).handler("connect worker", pi.ctx);
        const failure = pi.ctx.notifications.find(
          (entry) => entry.type === "error",
        );
        assert.ok(failure);
        assert.match(failure.message, /\/inter-agent setup/);
        assert.doesNotMatch(failure.message, /\/inter-agent doctor/);
      }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("connect recommends setup for a broken managed shebang", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-setup-broken-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-setup-broken-cwd-"));
  const bin = join(home, ".pi", "agent", "inter-agent", "venv", "bin");
  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "inter-agent", "venv", "pyvenv.cfg"),
      "home = /tmp/python\n",
    );
    for (const name of [
      "inter-agent-pi",
      "inter-agent-connect",
      "inter-agent-server",
    ]) {
      const path = join(bin, name);
      writeFileSync(path, "#!/missing-python\nexit 0\n");
      chmodSync(path, 0o755);
    }
    await withoutHelperOverride(() =>
      withExtension(home, cwd, async (pi) => {
        await command(pi).handler("connect worker", pi.ctx);
        const failure = pi.ctx.notifications.find(
          (entry) => entry.type === "error",
        );
        assert.ok(failure);
        assert.match(failure.message, /\/inter-agent setup/);
        assert.doesNotMatch(failure.message, /\/inter-agent doctor/);
      }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("connect recommends doctor for a partial PATH runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-path-partial-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-path-partial-cwd-"));
  const pathDir = mkdtempSync(join(tmpdir(), "ia-path-partial-bin-"));
  const oldPath = process.env.PATH;
  try {
    const path = join(pathDir, "inter-agent-pi");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
    writeFileSync(join(pathDir, "inter-agent-connect"), "#!/bin/sh\nexit 0\n");
    await withoutHelperOverride(() =>
      withExtension(home, cwd, async (pi) => {
        process.env.PATH = pathDir;
        await command(pi).handler("connect worker", pi.ctx);
        const failure = pi.ctx.notifications.find(
          (entry) => entry.type === "error",
        );
        assert.ok(failure);
        assert.match(failure.message, /\/inter-agent doctor/);
        assert.doesNotMatch(failure.message, /\/inter-agent setup/);
      }),
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(pathDir, { recursive: true, force: true });
  }
});

test("PATH resolution skips a non-executable shadow and uses a later valid helper", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-path-shadow-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-path-shadow-cwd-"));
  const first = mkdtempSync(join(tmpdir(), "ia-path-shadow-first-"));
  const later = mkdtempSync(join(tmpdir(), "ia-path-shadow-later-"));
  const oldPath = process.env.PATH;
  try {
    const shadow = join(first, "inter-agent-pi");
    writeFileSync(shadow, "#!/bin/sh\nexit 0\n");
    chmodSync(shadow, 0o644);
    for (const name of [
      "inter-agent-pi",
      "inter-agent-connect",
      "inter-agent-server",
    ]) {
      const path = join(later, name);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    _setSpawnForTest(((commandName: string, args: string[]) => {
      const proc = new EventEmitter() as FakeProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end: () => {} };
      proc.kill = () => {};
      queueMicrotask(() => {
        proc.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ op: "list_ok", sessions: [] }) + "\n"),
        );
        proc.emit("close", 0);
      });
      void commandName;
      void args;
      return proc;
    }) as never);
    await withExtension(home, cwd, async (pi) => {
      process.env.PATH = `${first}${delimiter}${later}`;
      await command(pi).handler("list", pi.ctx);
      assert.match(
        pi.ctx.notifications[pi.ctx.notifications.length - 1]?.message ?? "",
        /no agents connected/,
      );
    });
  } finally {
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(later, { recursive: true, force: true });
  }
});

test("outgoing tools preserve results and record history once", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-outgoing-execute-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-outgoing-execute-cwd-"));
  const oldPath = process.env.PATH;
  try {
    createHelperScripts(home);
    _setSpawnForTest(((commandName: string, args: string[]) => {
      const proc = new EventEmitter() as FakeProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end: () => {} };
      proc.kill = () => {
        proc.emit("exit", 0, null);
        proc.emit("close", 0);
      };
      queueMicrotask(() => {
        if (args[0] === "status") {
          proc.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ state: "available" }) + "\n"),
          );
        } else if (args[0] === "connect") {
          proc.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ op: "welcome" }) + "\n"),
          );
          return;
        }
        proc.emit("close", 0);
      });
      void commandName;
      return proc;
    }) as never);
    await withExtension(home, cwd, async (pi) => {
      process.env.PATH = join(home, "empty-bin");
      mkdirSync(process.env.PATH, { recursive: true });
      await command(pi).handler("connect sender", pi.ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const send = pi.tools.find((entry) => entry.name === "inter_agent_send");
      const broadcast = pi.tools.find(
        (entry) => entry.name === "inter_agent_broadcast",
      );
      assert.ok(send);
      assert.ok(broadcast);
      const sent = (await send.execute(
        "send-id",
        { to: "worker-a", text: "Please run the focused tests." },
        undefined,
        undefined,
        pi.ctx,
      )) as { content: { text: string }[]; details: unknown };
      const broadcastResult = (await broadcast.execute(
        "broadcast-id",
        { text: "Pause deployments until verification completes." },
        undefined,
        undefined,
        pi.ctx,
      )) as { content: { text: string }[]; details: unknown };
      assert.equal(
        sent.content[0]?.text,
        "Message sent from the current agent to worker-a",
      );
      assert.deepEqual(sent.details, {
        to: "worker-a",
        text: "Please run the focused tests.",
      });
      assert.equal(
        broadcastResult.content[0]?.text,
        "Broadcast sent to all other agents",
      );
      assert.deepEqual(broadcastResult.details, {
        text: "Pause deployments until verification completes.",
      });
      const history = pi.sentMessages.filter((args) => {
        const message = args[0] as { customType?: string; details?: unknown };
        const details = message.details as { outgoing?: boolean } | undefined;
        return (
          message.customType === "inter-agent-message" && details?.outgoing
        );
      });
      assert.equal(history.length, 2);
    });
  } finally {
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("outgoing tool renderers keep collapsed output compact", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-outgoing-render-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-outgoing-render-cwd-"));
  try {
    await withExtension(home, cwd, async (pi) => {
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const send = pi.tools.find((entry) => entry.name === "inter_agent_send");
      const broadcast = pi.tools.find(
        (entry) => entry.name === "inter_agent_broadcast",
      );
      assert.ok(send?.renderCall);
      assert.ok(send?.renderResult);
      assert.ok(broadcast?.renderCall);
      assert.ok(broadcast?.renderResult);

      const sendCall = send.renderCall?.(
        { to: "worker-a", text: "Please run the focused tests." },
        theme,
        {},
      ) as { render: (width: number) => string[] };
      const sendCollapsed = send.renderResult?.(
        {
          content: [{ type: "text", text: "Message sent" }],
          details: { to: "worker-a", text: "Please run the focused tests." },
        },
        { expanded: false, isPartial: false },
        theme,
        {
          args: { to: "worker-a", text: "Please run the focused tests." },
          isError: false,
        },
      ) as { render: (width: number) => string[] };
      assert.equal(renderText(sendCall), "inter_agent_send");
      assert.equal(renderText(sendCollapsed), "");

      const sendExpanded = send.renderResult?.(
        {
          content: [{ type: "text", text: "Message sent" }],
          details: { to: "worker-a", text: "Please run the focused tests." },
        },
        { expanded: true, isPartial: false },
        theme,
        {
          args: { to: "worker-a", text: "Please run the focused tests." },
          isError: false,
        },
      ) as { render: (width: number) => string[] };
      assert.equal(
        [sendCall, sendExpanded]
          .flatMap((component) =>
            component.render(120).map((line) => line.trimEnd()),
          )
          .join("\n"),
        "inter_agent_send\n\nTo: worker-a\n\nMessage: Please run the focused tests.",
      );
      assert.doesNotMatch(renderText(sendCollapsed), /worker-a|focused tests/);

      const broadcastCall = broadcast.renderCall?.({}, theme, {}) as {
        render: (width: number) => string[];
      };
      const broadcastExpanded = broadcast.renderResult?.(
        {
          content: [{ type: "text", text: "Broadcast sent" }],
          details: { text: "Pause deployments until verification completes." },
        },
        { expanded: true, isPartial: false },
        theme,
        {
          args: { text: "Pause deployments until verification completes." },
          isError: false,
        },
      ) as { render: (width: number) => string[] };
      assert.equal(
        [broadcastCall, broadcastExpanded]
          .flatMap((component) =>
            component.render(120).map((line) => line.trimEnd()),
          )
          .join("\n"),
        "inter_agent_broadcast\n\nTo: everyone\n\nMessage: Pause deployments until verification completes.",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("outgoing tool renderers preserve multiline messages and errors", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-outgoing-multiline-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-outgoing-multiline-cwd-"));
  try {
    await withExtension(home, cwd, async (pi) => {
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const send = pi.tools.find((entry) => entry.name === "inter_agent_send");
      assert.ok(send?.renderResult);
      const multiline = "first line\nsecond line\nthird line";
      const expanded = send.renderResult?.(
        {
          content: [{ type: "text", text: "Message sent" }],
          details: { to: "worker-a", text: multiline },
        },
        { expanded: true, isPartial: false },
        theme,
        { args: { to: "worker-a", text: multiline }, isError: false },
      ) as { render: (width: number) => string[] };
      assert.equal(
        renderText(expanded),
        `\nTo: worker-a\n\nMessage: ${multiline}`,
      );

      const failure = send.renderResult?.(
        {
          content: [{ type: "text", text: "send failed: unavailable" }],
          details: undefined,
        },
        { expanded: false, isPartial: false },
        theme,
        { args: { to: "worker-a", text: multiline }, isError: true },
      ) as { render: (width: number) => string[] };
      assert.equal(renderText(failure), "send failed: unavailable");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("list sorts routing names and renders one client per line", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-list-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-list-cwd-"));
  const calls: { command: string; args: string[] }[] = [];
  try {
    createHelperScripts(home);
    _setSpawnForTest(((commandName: string, args: string[]) => {
      const proc = new EventEmitter() as FakeProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end: () => {} };
      proc.kill = () => {};
      calls.push({ command: commandName, args });
      queueMicrotask(() => {
        proc.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              op: "list_ok",
              sessions: [
                { name: "zulu", label: "Z" },
                { name: "alpha", label: "A" },
                { name: "mike" },
              ],
            }) + "\n",
          ),
        );
        proc.emit("close", 0);
      });
      return proc;
    }) as never);
    await withExtension(home, cwd, async (pi) => {
      await command(pi).handler("list", pi.ctx);
      const notification =
        pi.ctx.notifications[pi.ctx.notifications.length - 1]?.message ?? "";
      assert.match(notification, /• alpha \(A\)\n• mike\n• zulu \(Z\)/);
      assert.doesNotMatch(notification, /alpha.*mike.*zulu/);

      const tool = pi.tools.find((entry) => entry.name === "inter_agent_list");
      assert.ok(tool);
      const result = (await tool.execute(
        "id",
        {},
        undefined,
        undefined,
        pi.ctx,
      )) as {
        content: { text: string }[];
      };
      assert.equal(result.content[0]?.text, "• alpha (A)\n• mike\n• zulu (Z)");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
