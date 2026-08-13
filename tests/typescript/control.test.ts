import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_COMMANDS,
  CONTROL_CUSTOM_TYPE,
  CONTROL_DEDUP_PER_SENDER,
  CONTROL_FINAL_TEXT_MAX_BYTES,
  CONTROL_INJECTED_TEXT_MAX_BYTES,
  CONTROL_RESPONSE_QUEUE_MAX,
  ControlEngine,
  describeFinalAssistant,
  isValidRoutingName,
  parseAllowControlFlag,
  parseControlRequestPayload,
  parseControlResponsePayload,
} from "../../src/control.js";
import type { ControlHost, ControlResponse } from "../../src/control.js";

// ── Fakes ───────────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

class FakeHost implements ControlHost {
  idle = true;
  pending = false;
  streaming = false;
  listenerReady = true;
  name: string | null = "worker-a";
  userMessages: {
    text: string;
    deliverAs: "steer" | "followUp" | undefined;
  }[] = [];
  aborts = 0;
  shutdowns = 0;
  submitted: { controller: string; payload: ControlResponse }[] = [];
  submitFailures: string[] = [];
  submitErrors = new Map<string, Error>();
  admissionGate: Promise<void> | null = null;
  warnings: string[] = [];

  isIdle(): boolean {
    return this.idle;
  }
  hasPendingMessages(): boolean {
    return this.pending;
  }
  isStreaming(): boolean {
    return this.streaming;
  }
  isListenerReady(): boolean {
    return this.listenerReady;
  }
  selfName(): string | null {
    return this.name;
  }
  submitUserMessage(
    text: string,
    deliverAs: "steer" | "followUp" | undefined,
  ): Promise<void> {
    this.userMessages.push({ text, deliverAs });
    const error = this.submitErrors.get(text);
    if (error) return Promise.reject(error);
    return this.admissionGate ?? Promise.resolve();
  }
  abort(): void {
    this.aborts += 1;
  }
  shutdown(): void {
    this.shutdowns += 1;
  }
  submitControlResponse(
    controller: string,
    payload: ControlResponse,
  ): Promise<boolean> {
    this.submitted.push({ controller, payload });
    return Promise.resolve(!this.submitFailures.includes(controller));
  }
  notifyWarning(body: string): void {
    this.warnings.push(body);
  }

  responses(): ControlResponse[] {
    return this.submitted.map((s) => s.payload);
  }
  responsesFor(id: string): ControlResponse[] {
    return this.submitted
      .map((s) => s.payload)
      .filter((p) => p.id === id && p.kind === "response");
  }
}

function makeEngine(
  host: FakeHost,
  allowControlBy: unknown = "leader,supervisor",
): { engine: ControlEngine; pi: FakePi } {
  const pi = new FakePi();
  const engine = new ControlEngine(pi as never, host);
  engine.onSessionStart(undefined, allowControlBy);
  return { engine, pi };
}

function request(
  command: string,
  args: Record<string, unknown> = {},
  id: unknown = "req-1",
): Record<string, unknown> {
  return { kind: "request", id, command, args };
}

function send(engine: ControlEngine, fromName: string, payload: unknown): void {
  engine.handleInboundCustomFrame({
    msgId: "m1",
    fromName,
    customType: CONTROL_CUSTOM_TYPE,
    payload,
  });
}

function assistantMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    stopReason: "stop",
    ...overrides,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Flag parsing and routing names ──────────────────────────────────────────

test("parseAllowControlFlag trims, deduplicates, and validates entries", () => {
  assert.deepEqual(parseAllowControlFlag("leader, supervisor, leader"), {
    ok: true,
    names: ["leader", "supervisor"],
  });
  assert.deepEqual(parseAllowControlFlag("worker-a"), {
    ok: true,
    names: ["worker-a"],
  });
  assert.deepEqual(parseAllowControlFlag("  "), {
    ok: false,
    message: "--allow-control-by contains an empty entry",
  });
  assert.deepEqual(parseAllowControlFlag(""), {
    ok: false,
    message: "--allow-control-by contains an empty entry",
  });
  assert.deepEqual(parseAllowControlFlag("leader,"), {
    ok: false,
    message: "--allow-control-by contains an empty entry",
  });
  const invalid = parseAllowControlFlag("Leader");
  assert.equal(invalid.ok, false);
  assert.ok(invalid.message.includes("not a valid routing name"));
  assert.equal(parseAllowControlFlag(42).ok, false);
  assert.equal(parseAllowControlFlag(null).ok, false);
});

test("isValidRoutingName mirrors the core name rule", () => {
  assert.equal(isValidRoutingName("leader"), true);
  assert.equal(isValidRoutingName("worker-a"), true);
  assert.equal(isValidRoutingName("a"), true);
  assert.equal(isValidRoutingName("a1"), true);
  assert.equal(isValidRoutingName("Leader"), false);
  assert.equal(isValidRoutingName(""), false);
  assert.equal(isValidRoutingName("-leader"), false);
  assert.equal(isValidRoutingName("leader_"), false);
  assert.equal(isValidRoutingName("l".repeat(40)), true);
  assert.equal(isValidRoutingName("l".repeat(41)), false);
  assert.equal(isValidRoutingName(7), false);
});

// ── Strict request parsing ──────────────────────────────────────────────────

test("strict request parse accepts the six commands with exact args", () => {
  for (const command of CONTROL_COMMANDS) {
    const args =
      command === "abort" || command === "state" || command === "shutdown"
        ? {}
        : { text: "do the thing" };
    const parsed = parseControlRequestPayload(
      request(command, args, `id-${command}`),
    );
    assert.equal(parsed.status, "ok");
    if (parsed.status === "ok") {
      assert.equal(parsed.request.command, command);
      assert.equal(parsed.request.id, `id-${command}`);
    }
  }
});

test("strict request parse rejects unknown and extra fields with a response", () => {
  const extra = parseControlRequestPayload({
    kind: "request",
    id: "r1",
    command: "prompt",
    args: { text: "x" },
    extra: true,
  });
  assert.equal(extra.status, "reject");
  if (extra.status === "reject") {
    assert.equal(extra.code, "malformed_request");
    assert.equal(extra.id, "r1");
  }

  const badArgs = parseControlRequestPayload(
    request("prompt", { text: "x", other: 1 }),
  );
  assert.equal(badArgs.status, "reject");
  if (badArgs.status === "reject")
    assert.equal(badArgs.code, "malformed_request");

  const emptyArgs = parseControlRequestPayload(request("prompt", {}, "r2"));
  assert.equal(emptyArgs.status, "reject");

  const nonObjectArgs = parseControlRequestPayload(
    request("state", 5 as never, "r3"),
  );
  assert.equal(nonObjectArgs.status, "reject");

  const badTextType = parseControlRequestPayload(
    request("steer", { text: 7 }, "r4"),
  );
  assert.equal(badTextType.status, "reject");

  const emptyText = parseControlRequestPayload(
    request("follow_up", { text: "" }, "r5"),
  );
  assert.equal(emptyText.status, "ok");

  // abort/state/shutdown require exactly {}.
  const noisy = parseControlRequestPayload(
    request("abort", { text: "x" }, "r6"),
  );
  assert.equal(noisy.status, "reject");
});

test("strict request parse rejects oversized injected text", () => {
  const over = "x".repeat(CONTROL_INJECTED_TEXT_MAX_BYTES + 1);
  const parsed = parseControlRequestPayload(request("prompt", { text: over }));
  assert.equal(parsed.status, "reject");
  if (parsed.status === "reject")
    assert.equal(parsed.code, "malformed_request");

  const atCap = "x".repeat(CONTROL_INJECTED_TEXT_MAX_BYTES);
  assert.equal(
    parseControlRequestPayload(request("prompt", { text: atCap })).status,
    "ok",
  );
});

test("strict request parse drops frames that cannot produce a response", () => {
  assert.equal(parseControlRequestPayload(null).status, "drop");
  assert.equal(parseControlRequestPayload([]).status, "drop");
  assert.equal(parseControlRequestPayload("nope").status, "drop");
  assert.equal(
    parseControlRequestPayload({ kind: "response", id: "r" }).status,
    "drop",
  );
  assert.equal(
    parseControlRequestPayload(request("prompt", { text: "x" }, "")).status,
    "drop",
  );
  assert.equal(
    parseControlRequestPayload(request("prompt", { text: "x" }, 5)).status,
    "drop",
  );
  assert.equal(
    parseControlRequestPayload(
      request("prompt", { text: "x" }, "bad id with spaces"),
    ).status,
    "drop",
  );
  assert.equal(
    parseControlRequestPayload(
      request("prompt", { text: "x" }, "x".repeat(128)),
    ).status,
    "ok",
  );
  assert.equal(
    parseControlRequestPayload(
      request("prompt", { text: "x" }, "x".repeat(129)),
    ).status,
    "drop",
  );
});

test("unsupported command rejects with the command echoed", () => {
  const parsed = parseControlRequestPayload(request("teleport", {}, "r1"));
  assert.equal(parsed.status, "reject");
  if (parsed.status === "reject") {
    assert.equal(parsed.code, "unsupported_command");
    assert.equal(parsed.command, "teleport");
  }
});

// ── Strict response parsing ─────────────────────────────────────────────────

function responsePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "response",
    id: "req-1",
    command: "prompt",
    phase: "settled",
    sequence: 2,
    data: { text: "done" },
    error: null,
    ...overrides,
  };
}

test("strict response parse accepts a well-formed response", () => {
  const parsed = parseControlResponsePayload(responsePayload());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.response.phase, "settled");
    assert.equal(parsed.response.sequence, 2);
    assert.deepEqual(parsed.response.data, { text: "done" });
    assert.equal(parsed.response.error, null);
  }
});

test("strict response parse accepts rejection error shapes and rejects invalid ones", () => {
  assert.equal(
    parseControlResponsePayload(
      responsePayload({
        phase: "rejected",
        error: { code: "busy", message: "busy" },
      }),
    ).ok,
    true,
  );
  assert.equal(
    parseControlResponsePayload(
      responsePayload({ error: { code: "busy", message: "busy" } }),
    ).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ phase: "failed" })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ phase: "bogus" })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ sequence: -1 })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ sequence: 1.5 })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ error: { code: "x" } })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ extra: true })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(responsePayload({ kind: "request" })).ok,
    false,
  );
  assert.equal(
    parseControlResponsePayload(
      responsePayload({ error: { code: "busy", message: "m".repeat(2000) } }),
    ).ok,
    false,
  );
});

// ── Authorization ───────────────────────────────────────────────────────────

test("authorization uses envelope from_name and never payload identity", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "intruder", request("state", {}, "r1"));
  assert.equal(host.userMessages.length, 0);
  const rejection = host.responsesFor("r1").slice(-1)[0];
  assert.equal(rejection?.phase, "rejected");
  assert.equal(rejection?.error?.code, "unauthorized");

  // A payload-level identity field is an unknown extra field and is rejected
  // as malformed; it is never trusted for authorization and never executes.
  const before = host.responses().length;
  send(engine, "intruder", {
    kind: "request",
    id: "r2",
    command: "prompt",
    args: { text: "x" },
    from_name: "leader",
  });
  assert.equal(
    host.userMessages.length,
    0,
    "payload identity must not authorize",
  );
  const payloadRejection = host.responses().slice(before);
  assert.equal(payloadRejection.length, 1);
  assert.equal(payloadRejection[0].phase, "rejected");
  assert.equal(payloadRejection[0].error?.code, "malformed_request");
});

test("control-disabled target rejects with unauthorized and never executes", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, null);
  send(engine, "leader", request("prompt", { text: "x" }, "r1"));
  assert.equal(host.userMessages.length, 0);
  const rejection = host.responsesFor("r1").slice(-1)[0];
  assert.equal(rejection?.phase, "rejected");
  assert.equal(rejection?.error?.code, "unauthorized");
  assert.ok(rejection?.error?.message.includes("disabled"));
});

// ── Command state machine ───────────────────────────────────────────────────

test("prompt accepts while idle, injects, and settles with final text", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "write a poem" }, "p1"));
  await tick();
  assert.deepEqual(host.userMessages, [
    { text: "write a poem", deliverAs: undefined },
  ]);
  const accepted = host.responsesFor("p1").find((r) => r.phase === "accepted");
  const started = host.responsesFor("p1").find((r) => r.phase === "started");
  assert.equal(accepted?.sequence, 0);
  assert.equal(started?.sequence, 1);
  assert.equal(started?.error, null);

  engine.observeMessageEnd(
    assistantMessage({ content: [{ type: "text", text: "done" }] }),
  );
  engine.onAgentSettled();
  await tick();
  const settled = host.responsesFor("p1").find((r) => r.phase === "settled");
  assert.equal(settled?.sequence, 2);
  assert.equal(settled?.data.text, "done");
  assert.equal(settled?.data.bytes, 4);
  assert.equal(settled?.data.truncated, false);
  assert.equal(settled?.data.interleaved, false);
  assert.equal(settled?.error, null);
});

test("submission rejection reports an error without started", async () => {
  const host = new FakeHost();
  host.submitErrors.set("blocked", new Error("input was handled"));
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "blocked" }, "reject-1"));
  await tick();
  const responses = host.responsesFor("reject-1");
  assert.deepEqual(
    responses.map((response) => response.phase),
    ["accepted", "rejected"],
  );
  assert.equal(responses[1].sequence, 1);
  assert.equal(responses[1].error?.code, "operation_failed");
  engine.onAgentSettled();
  await tick();
  assert.equal(host.responsesFor("reject-1").length, 2);
});

test("prompt while active or not idle is rejected as busy", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  assert.equal(host.responsesFor("p1").slice(-1)[0]?.error?.code, "busy");
  assert.equal(host.userMessages.length, 0);

  host.idle = true;
  host.pending = true;
  send(engine, "leader", request("prompt", { text: "x" }, "p2"));
  assert.equal(host.responsesFor("p2").slice(-1)[0]?.error?.code, "busy");

  host.pending = false;
  send(engine, "leader", request("prompt", { text: "x" }, "p3"));
  // A second run-affecting request while the first op is active is busy.
  send(engine, "leader", request("prompt", { text: "y" }, "p4"));
  assert.equal(host.responsesFor("p4").slice(-1)[0]?.error?.code, "busy");
  assert.equal(host.userMessages.length, 1);
});

test("steer and follow_up require an active run and use the right delivery", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");

  // Idle: steer/follow_up reject with invalid_state advising prompt.
  send(engine, "leader", request("steer", { text: "s" }, "s1"));
  const idleSteer = host.responsesFor("s1").slice(-1)[0];
  assert.equal(idleSteer?.phase, "rejected");
  assert.equal(idleSteer?.error?.code, "invalid_state");
  assert.ok(idleSteer?.error?.message.includes("prompt"));

  host.idle = false;
  send(engine, "leader", request("steer", { text: "s" }, "s2"));
  await tick();
  assert.deepEqual(host.userMessages.slice(-1)[0], {
    text: "s",
    deliverAs: "steer",
  });

  // follow_up waits behind the current op: a second op is busy.
  send(engine, "leader", request("follow_up", { text: "f" }, "s3"));
  assert.equal(host.responsesFor("s3").slice(-1)[0]?.error?.code, "busy");

  // After settlement a fresh follow_up injects with followUp delivery.
  engine.onAgentSettled();
  await tick();
  host.idle = false;
  send(engine, "leader", request("follow_up", { text: "f" }, "s4"));
  await tick();
  assert.deepEqual(host.userMessages.slice(-1)[0], {
    text: "f",
    deliverAs: "followUp",
  });
});

test("state works during active work and returns a privacy-safe payload", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader,supervisor");
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  send(engine, "leader", request("state", {}, "st1"));
  const state = host.responsesFor("st1").find((r) => r.phase === "settled");
  assert.ok(state, "state settled response missing");
  assert.equal(state?.data.name, "worker-a");
  assert.equal(state?.data.controlEnabled, true);
  assert.equal(state?.data.lifecycle, "busy");
  assert.equal(state?.data.pendingMessages, false);
  assert.equal(state?.data.allowlistCount, 2);
  assert.equal(state?.data.listenerReady, true);
  assert.deepEqual(state?.data.activeRequest, {
    id: "p1",
    command: "prompt",
    controller: "leader",
  });
  // The allowlist values are never disclosed (count only); no paths or models.
  const serialized = JSON.stringify(state?.data ?? {});
  assert.ok(!serialized.includes("supervisor"));
  assert.ok(!serialized.includes('"allowlist"'));
  assert.ok(!serialized.includes("/"));
  assert.ok(!serialized.includes("model"));
});

test("abort while idle is a successful no-op without calling abort", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("abort", {}, "a1"));
  const phases = host.responsesFor("a1").map((r) => r.phase);
  assert.deepEqual(phases, ["accepted", "settled"]);
  assert.equal(host.aborts, 0);
});

test("human-only abort waits for settlement and appears in state", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("abort", {}, "human-abort"));
  assert.equal(host.aborts, 1);
  assert.deepEqual(
    host.responsesFor("human-abort").map((response) => response.phase),
    ["accepted", "started"],
  );
  const humanAbortResponses = host.responsesFor("human-abort");
  assert.equal(
    humanAbortResponses[humanAbortResponses.length - 1]?.phase,
    "started",
  );
  send(engine, "leader", request("state", {}, "state-abort"));
  assert.deepEqual(
    host.responsesFor("state-abort").slice(-1)[0]?.data.activeRequest,
    {
      id: "human-abort",
      command: "abort",
      controller: "leader",
    },
  );
  engine.onAgentSettled();
  await tick();
  const settledHumanAbort = host.responsesFor("human-abort");
  assert.equal(
    settledHumanAbort[settledHumanAbort.length - 1]?.phase,
    "settled",
  );
});

test("abort interrupts an active op and dual-settles at agent_settled", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("steer", { text: "s" }, "p1"));
  await tick();
  send(engine, "leader", request("abort", {}, "a1"));
  assert.equal(host.aborts, 1);
  assert.deepEqual(
    host.responsesFor("a1").map((response) => response.phase),
    ["accepted", "started"],
  );

  // Streaming stops; the run settles.
  engine.onAgentSettled();
  await tick();
  const interrupted = host.responsesFor("p1").slice(-1)[0];
  assert.equal(interrupted?.phase, "failed");
  assert.equal(interrupted?.error?.code, "operation_aborted");
  assert.equal(interrupted?.sequence, 2);
  const abortDone = host.responsesFor("a1").slice(-1)[0];
  assert.equal(abortDone?.phase, "settled");
  assert.equal(abortDone?.sequence, 2);
  assert.deepEqual(abortDone?.data, { aborted: true, interleaved: false });

  // The engine is idle again for a fresh run-affecting op.
  host.idle = true;
  send(engine, "leader", request("prompt", { text: "x" }, "p2"));
  assert.equal(host.userMessages.length, 2);
});

test("abort finalizes immediately when nothing is running after the abort", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("steer", { text: "s" }, "p1"));
  await tick();
  // After the abort the agent is already idle with nothing queued: no
  // agent_settled will arrive, so the pair settles immediately.
  host.idle = true;
  send(engine, "leader", request("abort", {}, "a1"));
  assert.equal(
    host.responsesFor("p1").slice(-1)[0]?.error?.code,
    "operation_aborted",
  );
  assert.equal(host.responsesFor("a1").slice(-1)[0]?.phase, "settled");
  assert.equal(host.aborts, 1);
});

test("abort during admission is applied after admission and settles the pair", async () => {
  const host = new FakeHost();
  let release!: () => void;
  host.admissionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "gated" }, "gated"));
  await tick();
  send(engine, "leader", request("abort", {}, "gated-abort"));
  assert.equal(host.aborts, 0);
  host.idle = false;
  release();
  await tick();
  assert.equal(host.aborts, 1);
  assert.equal(
    host.responsesFor("gated").some((r) => r.phase === "started"),
    true,
  );
  engine.onAgentSettled();
  await tick();
  assert.equal(
    host.responsesFor("gated").slice(-1)[0]?.error?.code,
    "operation_aborted",
  );
  assert.equal(host.responsesFor("gated-abort").slice(-1)[0]?.phase, "settled");
});

test("abort is serialized against a pending standalone abort", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("abort", {}, "human-abort"));
  send(engine, "leader", request("prompt", { text: "blocked" }, "blocked"));
  assert.equal(host.userMessages.length, 0);
  assert.equal(host.responsesFor("blocked").slice(-1)[0]?.error?.code, "busy");
  engine.onAgentSettled();
  await tick();
});

test("shutdown acknowledges, calls shutdown, and rejects later requests", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("shutdown", {}, "sh1"));
  assert.equal(host.shutdowns, 1);
  const settled = host.responsesFor("sh1").find((r) => r.phase === "settled");
  assert.equal(settled?.data.shutdownRequested, true);
  assert.equal(settled?.data.wasActive, true);

  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  assert.equal(
    host.responsesFor("p1").slice(-1)[0]?.error?.code,
    "shutting_down",
  );
  assert.equal(host.userMessages.length, 0);
  send(engine, "leader", request("state", {}, "st1"));
  assert.equal(
    host.responsesFor("st1").slice(-1)[0]?.error?.code,
    "shutting_down",
  );
  send(engine, "leader", request("abort", {}, "a1"));
  assert.equal(
    host.responsesFor("a1").slice(-1)[0]?.error?.code,
    "shutting_down",
  );
});

test("same abort id is isolated by controller during active work", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader,supervisor");
  host.idle = false;
  send(engine, "leader", request("steer", { text: "s" }, "run"));
  await tick();
  send(engine, "leader", request("abort", {}, "same"));
  send(engine, "supervisor", request("abort", {}, "same"));
  assert.deepEqual(
    host.responsesFor("same").map((response) => response.phase),
    ["accepted", "started", "accepted", "started"],
  );
  assert.equal(host.aborts, 1);
  engine.onAgentSettled();
  await tick();
  assert.equal(
    host.responsesFor("same").filter((response) => response.phase === "settled")
      .length,
    2,
  );
});

test("same abort id is isolated by controller during standalone work", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader,supervisor");
  host.idle = false;
  send(engine, "leader", request("abort", {}, "same"));
  send(engine, "supervisor", request("abort", {}, "same"));
  assert.equal(host.aborts, 1);
  assert.deepEqual(
    host.responsesFor("same").map((response) => response.phase),
    ["accepted", "started", "accepted", "started"],
  );
  engine.onAgentSettled();
  await tick();
  assert.equal(
    host.responsesFor("same").filter((response) => response.phase === "settled")
      .length,
    2,
  );
});

test("two aborts settle both abort requests at the pair finalize", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader,supervisor");
  host.idle = false;
  send(engine, "leader", request("steer", { text: "s" }, "p1"));
  await tick();
  send(engine, "leader", request("abort", {}, "a1"));
  send(engine, "supervisor", request("abort", {}, "a2"));
  assert.equal(host.aborts, 1);
  assert.deepEqual(
    host.responsesFor("a2").map((response) => response.phase),
    ["accepted", "started"],
  );
  engine.onAgentSettled();
  await tick();
  assert.equal(
    host.responsesFor("p1").slice(-1)[0]?.error?.code,
    "operation_aborted",
  );
  assert.equal(host.responsesFor("a1").slice(-1)[0]?.phase, "settled");
  assert.equal(host.responsesFor("a2").slice(-1)[0]?.phase, "settled");
});

// ── Interleaving ────────────────────────────────────────────────────────────

test("human and unrelated extension input mark the result interleaved; fromSelf distinguishes identical text", async () => {
  const host = new FakeHost();
  const { engine, pi } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "guarded text" }, "p1"));
  await tick();
  assert.equal(host.userMessages.length, 1);

  // The host marks the submitting extension's own input with fromSelf.
  pi.fire("input", {
    text: "guarded text",
    source: "extension",
    fromSelf: true,
  });
  engine.observeMessageEnd(assistantMessage());
  engine.onAgentSettled();
  assert.equal(
    host.responsesFor("p1").find((r) => r.phase === "settled")?.data
      .interleaved,
    false,
  );

  // Interactive and rpc input mark interleaved.
  send(engine, "leader", request("prompt", { text: "again" }, "p2"));
  await tick();
  pi.fire("input", { text: "human typing", source: "interactive" });
  engine.observeMessageEnd(assistantMessage());
  engine.onAgentSettled();
  assert.equal(
    host.responsesFor("p2").find((r) => r.phase === "settled")?.data
      .interleaved,
    true,
  );

  send(engine, "leader", request("prompt", { text: "again2" }, "p3"));
  await tick();
  pi.fire("input", { text: "rpc input", source: "rpc" });
  engine.observeMessageEnd(assistantMessage());
  engine.onAgentSettled();
  assert.equal(
    host.responsesFor("p3").find((r) => r.phase === "settled")?.data
      .interleaved,
    true,
  );

  // Unrelated extension input, even with identical text, is interleaving.
  send(engine, "leader", request("prompt", { text: "mine" }, "p4"));
  await tick();
  pi.fire("input", { text: "mine", source: "extension", fromSelf: false });
  engine.observeMessageEnd(assistantMessage());
  engine.onAgentSettled();
  assert.equal(
    host.responsesFor("p4").find((r) => r.phase === "settled")?.data
      .interleaved,
    true,
  );
});

// ── Final assistant outcome ─────────────────────────────────────────────────

test("describeFinalAssistant extracts only final text blocks", () => {
  const outcome = describeFinalAssistant(
    assistantMessage({
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        {
          type: "toolCall",
          id: "t1",
          name: "bash",
          arguments: { command: "ls" },
        },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
  );
  assert.deepEqual(outcome, {
    kind: "text",
    text: "first\nsecond",
    bytes: 12,
    truncated: false,
  });
  assert.ok(!JSON.stringify(outcome).includes("secret reasoning"));
  assert.ok(!JSON.stringify(outcome).includes("bash"));
});

test("describeFinalAssistant reports errors and aborts, and no-text", () => {
  assert.equal(
    describeFinalAssistant(
      assistantMessage({
        stopReason: "error",
        errorMessage: "provider blew up",
      }),
    ).kind,
    "error",
  );
  assert.equal(
    describeFinalAssistant(assistantMessage({ stopReason: "aborted" })).kind,
    "aborted",
  );
  assert.equal(
    describeFinalAssistant(assistantMessage({ content: [] })).kind,
    "no-text",
  );
  assert.equal(
    describeFinalAssistant(
      assistantMessage({ content: [{ type: "thinking", thinking: "x" }] }),
    ).kind,
    "no-text",
  );
  assert.equal(
    describeFinalAssistant({ role: "user", content: "hi" }).kind,
    "no-text",
  );
  assert.equal(describeFinalAssistant(null).kind, "no-text");
});

test("final text is truncated at the byte cap with metadata", () => {
  const big = "a".repeat(CONTROL_FINAL_TEXT_MAX_BYTES + 100);
  const outcome = describeFinalAssistant(
    assistantMessage({ content: [{ type: "text", text: big }] }),
  );
  assert.equal(outcome.kind, "text");
  if (outcome.kind === "text") {
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.bytes, big.length);
    assert.ok(outcome.text.length <= CONTROL_FINAL_TEXT_MAX_BYTES);
  }
});

test("assistant error and no-text settle honestly at agent_settled", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  await tick();
  engine.observeMessageEnd(
    assistantMessage({ stopReason: "error", errorMessage: "model failed" }),
  );
  engine.onAgentSettled();
  const failed = host.responsesFor("p1").slice(-1)[0];
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "operation_failed");
  assert.ok((failed?.error?.message ?? "").includes("model failed"));

  send(engine, "leader", request("prompt", { text: "x" }, "p2"));
  await tick();
  engine.observeMessageEnd(assistantMessage({ content: [] }));
  engine.onAgentSettled();
  const noText = host.responsesFor("p2").slice(-1)[0];
  assert.equal(noText?.phase, "settled");
  assert.equal(noText?.data.resultUnavailable, true);
  assert.equal(noText?.data.text, undefined);
  assert.equal(noText?.error, null);
});

// ── Deduplication and replay ────────────────────────────────────────────────

test("duplicate id replays the latest status without executing again", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  await tick();
  assert.equal(host.userMessages.length, 1);

  // Same controller + same id mid-flight: replay latest status (started).
  send(engine, "leader", request("prompt", { text: "different" }, "p1"));
  await tick();
  assert.equal(host.userMessages.length, 1, "duplicate must not execute again");
  const replayedStarted = host.responsesFor("p1").slice(-1)[0];
  assert.equal(replayedStarted?.phase, "started");
  assert.equal(replayedStarted?.sequence, 1);

  engine.observeMessageEnd(assistantMessage());
  engine.onAgentSettled();
  await tick();
  // Terminal replay of the same id returns the cached settled result.
  send(engine, "leader", request("prompt", { text: "whatever" }, "p1"));
  await tick();
  const replayed = host.responsesFor("p1").slice(-1)[0];
  assert.equal(replayed?.phase, "settled");
  assert.equal(replayed?.data.text, "final answer");
  assert.equal(host.userMessages.length, 1);
});

test("deduplication is per sender", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader,supervisor");
  // state is not completion-tracked, so both senders may use the same id;
  // dedup keys are (sender, id), so both execute.
  send(engine, "leader", request("state", {}, "same"));
  send(engine, "supervisor", request("state", {}, "same"));
  assert.equal(
    host.responsesFor("same").filter((r) => r.phase === "accepted").length,
    2,
  );
  assert.equal(
    host.responsesFor("same").filter((r) => r.phase === "settled").length,
    2,
  );

  // A same-sender duplicate replays that sender's cached result only.
  const before = host.responses().length;
  send(engine, "leader", request("state", {}, "same"));
  const replayed = host.responses().slice(before);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].phase, "settled");
});

test("dedup eviction keeps the latest 256 records per sender", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  // 257 distinct state requests evict the first id.
  for (let i = 1; i <= CONTROL_DEDUP_PER_SENDER + 1; i++) {
    send(engine, "leader", request("state", {}, `id-${i}`));
  }
  const totalBefore = host.responses().length;

  // The evicted id executes again (a new accepted response arrives).
  send(engine, "leader", request("state", {}, "id-1"));
  const reExecuted = host.responses().slice(totalBefore);
  assert.equal(
    reExecuted.filter((r) => r.id === "id-1" && r.phase === "accepted").length,
    1,
  );

  // The newest id replays its cached settled response instead.
  const beforeReplay = host.responses().length;
  send(
    engine,
    "leader",
    request("state", {}, `id-${CONTROL_DEDUP_PER_SENDER + 1}`),
  );
  const replayed = host.responses().slice(beforeReplay);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].phase, "settled");
});

// ── Reconnect response queue ────────────────────────────────────────────────

test("responses queue while the listener is unavailable and flush on welcome", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.listenerReady = false;
  host.name = null;
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  await tick();
  assert.equal(host.submitted.length, 0, "no submissions while unready");

  // Welcome makes the bridge ready; the queued responses flush in order.
  host.listenerReady = true;
  host.name = "worker-a";
  engine.onListenerReady();
  await tick();
  const phases = host.responsesFor("p1").map((r) => r.phase);
  assert.deepEqual(phases, ["accepted", "started"]);
});

test("failed submissions queue and flush failures warn", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.submitFailures.push("leader");
  send(engine, "leader", request("state", {}, "st1"));
  await tick();
  // Both accepted and settled were attempted, failed, and queued (not submitted).
  assert.equal(host.submitted.length, 2);
  assert.equal(host.responsesFor("st1").length, 2);

  // The flush retries while the bridge still fails: the entry is dropped with
  // a bounded warning (the controller can deliberately replay the request id).
  engine.onListenerReady();
  await tick();
  assert.ok(host.warnings.some((w) => w.includes("queued control response")));
  assert.equal(host.submitted.length, 4);
});

test("the response queue is bounded", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.listenerReady = false;
  host.name = null;
  // Flood 300 distinct state requests; only 256 responses remain queued and
  // the overflow drops the oldest with a warning.
  for (let i = 0; i < CONTROL_RESPONSE_QUEUE_MAX + 50; i++) {
    send(engine, "leader", request("state", {}, `q-${i}`));
  }
  assert.ok(host.warnings.some((w) => w.includes("queue full")));
  host.listenerReady = true;
  host.name = "worker-a";
  engine.onListenerReady();
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    const flushed = host.submitted.length;
    assert.equal(flushed, CONTROL_RESPONSE_QUEUE_MAX);
  });
});

// ── Cleanup: reload and disconnect ──────────────────────────────────────────

test("reload fails active work with target_reloading and clears tracking", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  await tick();
  engine.onSessionShutdown("reload");
  await tick();
  const failed = host.responsesFor("p1").slice(-1)[0];
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "target_reloading");

  // After reload the registry is empty: the same id executes again.
  const before = host.userMessages.length;
  send(engine, "leader", request("prompt", { text: "y" }, "p1"));
  assert.equal(host.userMessages.length, before + 1);

  // A second reload fails that op; a fresh state request with the same id
  // executes (accepted + settled) rather than replaying the cleared record.
  engine.onSessionShutdown("reload");
  const before2 = host.responsesFor("p1").length;
  send(engine, "leader", request("state", {}, "p1"));
  assert.equal(host.responsesFor("p1").length, before2 + 2);
  assert.equal(host.responsesFor("p1").slice(-1)[0]?.phase, "settled");
});

test("explicit disconnect fails active work with target_disconnected", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "x" }, "p1"));
  engine.onExplicitDisconnect();
  const failed = host.responsesFor("p1").slice(-1)[0];
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "target_disconnected");
});

test("reload with a pending abort fails both requests with target_reloading", async () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  host.idle = false;
  send(engine, "leader", request("steer", { text: "s" }, "p1"));
  send(engine, "leader", request("abort", {}, "a1"));
  engine.onSessionShutdown("reload");
  assert.equal(
    host.responsesFor("p1").slice(-1)[0]?.error?.code,
    "target_reloading",
  );
  assert.equal(
    host.responsesFor("a1").slice(-1)[0]?.error?.code,
    "target_reloading",
  );
});

// ── Inbound classification ──────────────────────────────────────────────────

test("unknown kinds and malformed frames warn without responding", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", { kind: "query", id: "q1" });
  assert.equal(host.responses().length, 0);
  assert.ok(host.warnings.some((w) => w.includes("unknown kind")));
  send(engine, "leader", "not an object");
  assert.equal(host.responses().length, 0);
  assert.ok(host.warnings.some((w) => w.includes("non-object")));
});

test("malformed requests that cannot respond warn without responding", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  send(engine, "leader", request("prompt", { text: "x" }, "bad id"));
  assert.equal(host.responses().length, 0);
  assert.ok(host.warnings.some((w) => w.includes("malformed control request")));
});

test("valid responses are classified and never reach the mailbox", () => {
  const host = new FakeHost();
  const { engine } = makeEngine(host, "leader");
  const before = host.responses().length;
  send(engine, "leader", responsePayload());
  assert.equal(host.responses().length, before);
  assert.equal(host.warnings.length, 0);

  // A malformed response warns but is not an ordinary mailbox message either.
  send(engine, "leader", responsePayload({ phase: "bogus" }));
  assert.ok(
    host.warnings.some((w) => w.includes("malformed control response")),
  );
});
