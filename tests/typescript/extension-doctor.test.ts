import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ext, { _setSpawnForTest } from "../../src/index.js";

interface UserMessage {
  text: string;
  options: { expandPromptTemplates?: boolean; deliverAs?: string };
}

type Handler = (...args: unknown[]) => unknown;

class FakeCtx {
  readonly sessionManager = {
    getBranch: () => this.branch,
    getSessionId: () => "doctor-session",
  };
  readonly ui = {
    notify: (message: string, type = "info") =>
      this.notifications.push({ message, type }),
    setStatus: (_key: string, _text: string | undefined) => {},
  };
  readonly branch: unknown[] = [];
  readonly notifications: { message: string; type: string }[] = [];
  idle = true;
  pendingMessages = false;

  isIdle(): boolean {
    return this.idle;
  }

  hasPendingMessages(): boolean {
    return this.pendingMessages;
  }

  abort(): void {}

  shutdown(): void {}
}

class FakePi {
  readonly commands = new Map<string, { handler: Handler }>();
  readonly handlers = new Map<string, Handler[]>();
  readonly userMessages: UserMessage[] = [];
  readonly messages: unknown[] = [];
  readonly flags = new Map<string, unknown>();
  readonly ctx = new FakeCtx();
  doctorSkillAvailable: boolean | "collision" = true;
  getCommandsCalls = 0;

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, options: { handler: Handler }): void {
    this.commands.set(name, options);
  }

  registerTool(_tool: unknown): void {}

  registerMessageRenderer(_name: string, _renderer: unknown): void {}

  registerFlag(name: string, options: unknown): void {
    this.flags.set(name, options);
  }

  getFlag(_name: string): unknown {
    return undefined;
  }

  getCommands(): {
    name: string;
    source: string;
    sourceInfo: {
      source: string;
      scope: string;
      origin: string;
      baseDir?: string;
    };
  }[] {
    this.getCommandsCalls += 1;
    if (!this.doctorSkillAvailable) return [];
    const ownSourceInfo = {
      source: "npm:@arcanemachine/inter-agent-pi",
      scope: "user",
      origin: "package",
      baseDir: "/tmp/inter-agent-pi",
    };
    const skillSourceInfo =
      this.doctorSkillAvailable === "collision"
        ? { ...ownSourceInfo, source: "npm:other-doctor" }
        : ownSourceInfo;
    return [
      { name: "inter-agent", source: "extension", sourceInfo: ownSourceInfo },
      {
        name: "skill:inter-agent-doctor",
        source: "skill",
        sourceInfo: skillSourceInfo,
      },
    ];
  }

  sendMessage(..._args: unknown[]): void {
    this.messages.push(_args);
  }

  sendUserMessage(
    text: string,
    options: { expandPromptTemplates?: boolean; deliverAs?: string } = {},
  ): void {
    this.userMessages.push({ text, options });
  }

  appendEntry(..._args: unknown[]): void {}
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

async function withDoctorExtension(
  fn: (pi: FakePi) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ia-doctor-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ia-doctor-cwd-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(cwd, ".venv", "bin"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ interAgent: { projectPaths: [cwd] } }),
  );
  for (const name of [
    "inter-agent-pi",
    "inter-agent-connect",
    "inter-agent-server",
  ]) {
    writeFileSync(join(cwd, ".venv", "bin", name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(cwd, ".venv", "bin", name), 0o755);
  }
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(cwd);
  const pi = new FakePi();
  try {
    ext(pi as never);
    await runHandler(pi, "session_start", {}, pi.ctx);
    await fn(pi);
  } finally {
    await runHandler(pi, "session_shutdown", {}, pi.ctx);
    process.env.HOME = oldHome;
    process.chdir(oldCwd);
    _setSpawnForTest(null);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function doctorCommand(pi: FakePi): { handler: Handler } {
  const command = pi.commands.get("inter-agent");
  if (!command) throw new Error("inter-agent command not registered");
  return command;
}

test("doctor preserves direct context and enables prompt expansion", async () => {
  await withDoctorExtension(async (pi) => {
    await doctorCommand(pi).handler(
      "doctor observed: '$(touch no-file)' ; do not run\nsecond line",
      pi.ctx,
    );

    assert.equal(pi.getCommandsCalls, 1);
    assert.deepEqual(pi.userMessages, [
      {
        text: "/skill:inter-agent-doctor observed: '$(touch no-file)' ; do not run\nsecond line",
        options: { expandPromptTemplates: true },
      },
    ]);
  });
});

test("doctor queues a follow-up while the model is busy", async () => {
  await withDoctorExtension(async (pi) => {
    pi.ctx.idle = false;
    await doctorCommand(pi).handler("doctor busy context", pi.ctx);

    assert.deepEqual(pi.userMessages, [
      {
        text: "/skill:inter-agent-doctor busy context",
        options: { expandPromptTemplates: true, deliverAs: "followUp" },
      },
    ]);
  });
});

test("operational command failures suggest doctor and README", async () => {
  await withDoctorExtension(async (pi) => {
    await doctorCommand(pi).handler("send agent-b hello", pi.ctx);

    const failure = pi.ctx.notifications.find(
      (entry) =>
        entry.type === "error" && entry.message.includes("send failed"),
    );
    assert.ok(failure);
    assert.match(failure.message, /Not connected to the inter-agent bus/);
    assert.match(failure.message, /\/inter-agent doctor/);
    assert.match(failure.message, /README\.md/);
  });
});

test("usage failures do not suggest doctor", async () => {
  await withDoctorExtension(async (pi) => {
    await doctorCommand(pi).handler("send", pi.ctx);

    const failure = pi.ctx.notifications.find(
      (entry) =>
        entry.type === "error" && entry.message.includes("send failed"),
    );
    assert.ok(failure);
    assert.match(failure.message, /usage: \/inter-agent send/);
    assert.doesNotMatch(failure.message, /\/inter-agent doctor/);
  });
});

test("rename validates usage before its disconnected-state failure", async () => {
  await withDoctorExtension(async (pi) => {
    await doctorCommand(pi).handler("rename", pi.ctx);

    const failure = pi.ctx.notifications.find(
      (entry) =>
        entry.type === "error" && entry.message.includes("rename failed"),
    );
    assert.ok(failure);
    assert.match(failure.message, /usage: \/inter-agent rename/);
    assert.doesNotMatch(failure.message, /\/inter-agent doctor/);
  });
});

test("doctor submission failures do not suggest doctor recursively", async () => {
  await withDoctorExtension(async (pi) => {
    pi.sendUserMessage = () => {
      throw new Error("doctor submission failed");
    };
    await doctorCommand(pi).handler("doctor context", pi.ctx);

    const failure = pi.ctx.notifications.find(
      (entry) =>
        entry.type === "error" && entry.message.includes("doctor failed"),
    );
    assert.ok(failure);
    assert.match(failure.message, /README\.md/);
    assert.doesNotMatch(failure.message, /\/inter-agent doctor/);
  });
});

test("long command failures retain the doctor hint within the notification bound", async () => {
  await withDoctorExtension(async (pi) => {
    _setSpawnForTest((() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stderr.emit(
          "data",
          Buffer.from("inter-agent command was not found " + "x".repeat(5000)),
        );
        proc.emit("close", 1);
      });
      return proc;
    }) as never);

    await doctorCommand(pi).handler("list", pi.ctx);

    const failure = pi.ctx.notifications.find(
      (entry) =>
        entry.type === "error" && entry.message.includes("list failed"),
    );
    assert.ok(failure);
    assert.ok(failure.message.length <= 1000);
    assert.match(failure.message, /\/inter-agent doctor/);
    assert.match(failure.message, /README\.md/);
  });
});

test("doctor checks command availability and fails boundedly when missing", async () => {
  await withDoctorExtension(async (pi) => {
    pi.doctorSkillAvailable = false;
    let spawnCalls = 0;
    _setSpawnForTest((() => {
      spawnCalls += 1;
      throw new Error("doctor must not invoke a helper");
    }) as never);

    await doctorCommand(pi).handler("doctor context", pi.ctx);

    assert.equal(pi.getCommandsCalls, 1);
    assert.equal(pi.userMessages.length, 0);
    assert.equal(spawnCalls, 0);
    const failure = pi.ctx.notifications.find(
      (entry) => entry.type === "error" && entry.message.includes("doctor"),
    );
    assert.ok(failure);
    assert.ok(failure.message.length < 200);
    assert.match(failure.message, /README\.md/);
    assert.doesNotMatch(failure.message, /\/inter-agent doctor/);
  });
});

test("doctor rejects a same-name skill from another package", async () => {
  await withDoctorExtension(async (pi) => {
    pi.doctorSkillAvailable = "collision";
    await doctorCommand(pi).handler("doctor context", pi.ctx);

    assert.equal(pi.getCommandsCalls, 1);
    assert.equal(pi.userMessages.length, 0);
    const failure = pi.ctx.notifications.find(
      (entry) => entry.type === "error" && entry.message.includes("doctor"),
    );
    assert.ok(failure);
  });
});

test("doctor submits while disconnected without helper, bus, or state effects", async () => {
  await withDoctorExtension(async (pi) => {
    let spawnCalls = 0;
    _setSpawnForTest((() => {
      spawnCalls += 1;
      throw new Error("doctor must not invoke a helper");
    }) as never);

    // No connect command is issued, so this exercises the disconnected path.
    await doctorCommand(pi).handler("doctor", pi.ctx);

    assert.deepEqual(pi.userMessages, [
      {
        text: "/skill:inter-agent-doctor",
        options: { expandPromptTemplates: true },
      },
    ]);
    assert.equal(spawnCalls, 0);
    assert.equal(pi.messages.length, 0);
    assert.equal(pi.ctx.branch.length, 0);
  });
});
