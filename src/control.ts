/**
 * Inter-agent Pi control V1 protocol, target authorization, and lifecycle
 * engine.
 *
 * The extension classifies inbound `pi.control.v1` custom frames before
 * ordinary mailbox processing. Requests are strictly parsed, authorized only
 * by the server-supplied envelope `from_name` (payload identity is never
 * trusted), deduplicated per sender, and dispatched to the Pi runtime through
 * public extension APIs. Responses travel back over the target's own
 * persistent authenticated agent connection via the `control-send` bridge
 * helper; the bridge's local `submitted` acknowledgement is not a delivery or
 * acceptance claim.
 *
 * This module owns the strict request/response schemas, bounds, stable error
 * taxonomy, per-sender deduplication with deliberate replay, the serialized
 * completion-tracked target state machine for all six commands, abort
 * dual-settlement, shutdown ordering, reconnect response queueing, and
 * reload/disconnect cleanup. Task 4 (controller tool/command and terminal
 * result coalescing) builds on this module's classification and response
 * schema; this module only classifies inbound responses strictly and never
 * leaks control frames into the ordinary mailbox.
 *
 * Control state is process-local and bounded. Nothing here is persisted to
 * transcript entries, settings, environment, argv, or the filesystem.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTROL_CUSTOM_TYPE = "pi.control.v1";

// ── Bounds ──────────────────────────────────────────────────────────────────

export const CONTROL_ID_MAX = 128;
export const CONTROL_INJECTED_TEXT_MAX_BYTES = 32 * 1024;
export const CONTROL_FINAL_TEXT_MAX_BYTES = 8 * 1024;
export const CONTROL_ERROR_MESSAGE_MAX_BYTES = 1024;
export const CONTROL_COMMAND_MAX = 128;
export const CONTROL_ERROR_CODE_MAX = 64;
export const CONTROL_DEDUP_PER_SENDER = 256;
export const CONTROL_RESPONSE_QUEUE_MAX = 256;
export const CONTROL_ABORT_REQUESTS_MAX = 256;
export const CONTROL_JOINED_REQUESTS_MAX = 256;
export const CONTROL_PROMPT_START_TIMEOUT_MS = 5000;
export const CONTROL_INITIAL_ACK_TIMEOUT_MS = 5000;
export const CONTROL_PENDING_REQUESTS_MAX = 256;
export const CONTROL_RESULT_CUSTOM_TYPE = "inter-agent-control-result";

/** Safe identifier alphabet for request/response ids (UUIDs are the normal form). */
const CONTROL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Mirrors the core routing-name rule: lowercase, digits, hyphens, 1-40 chars. */
const ROUTING_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ── Protocol types ──────────────────────────────────────────────────────────

export type ControlCommand =
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "state"
  | "shutdown";

export const CONTROL_COMMANDS: readonly ControlCommand[] = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "state",
  "shutdown",
];

export type ControlPhase =
  | "accepted"
  | "started"
  | "settled"
  | "rejected"
  | "failed";

export const CONTROL_PHASES: readonly ControlPhase[] = [
  "accepted",
  "started",
  "settled",
  "rejected",
  "failed",
];

export type ControlErrorCode =
  | "malformed_request"
  | "unsupported_command"
  | "unauthorized"
  | "invalid_state"
  | "busy"
  | "operation_aborted"
  | "operation_failed"
  | "result_unavailable"
  | "target_reloading"
  | "target_disconnected"
  | "shutting_down";

export const CONTROL_ERROR_CODES: readonly ControlErrorCode[] = [
  "malformed_request",
  "unsupported_command",
  "unauthorized",
  "invalid_state",
  "busy",
  "operation_aborted",
  "operation_failed",
  "result_unavailable",
  "target_reloading",
  "target_disconnected",
  "shutting_down",
];

/** A strictly parsed control request (target side). */
export interface ControlRequest {
  id: string;
  command: ControlCommand;
  args: Record<string, unknown>;
  /** Present for prompt/steer/follow_up; null for abort/state/shutdown. */
  text: string | null;
}

/** A strictly parsed control response (controller side, consumed by Task 4). */
export interface ControlResponse {
  kind: "response";
  id: string;
  /** Echo of the request command; rejection responses may echo an unsupported command. */
  command: string;
  phase: ControlPhase;
  sequence: number;
  data: Record<string, unknown>;
  error: { code: string; message: string } | null;
}

export interface ControlWireRequest {
  kind: "request";
  id: string;
  command: ControlCommand;
  args: Record<string, unknown>;
}

export type ControlBuildResult =
  | { ok: true; request: ControlWireRequest }
  | { ok: false; message: string };

/** Build one strict wire request shared by the model tool and user command. */
export function buildControlRequest(
  target: unknown,
  command: unknown,
  text?: unknown,
  requestId?: unknown,
): ControlBuildResult {
  if (!isValidRoutingName(target)) {
    return { ok: false, message: "target must be an exact routing name" };
  }
  if (
    typeof command !== "string" ||
    !(CONTROL_COMMANDS as readonly string[]).includes(command)
  ) {
    return {
      ok: false,
      message:
        "command must be one of prompt, steer, follow_up, abort, state, shutdown",
    };
  }
  if (
    requestId !== undefined &&
    (typeof requestId !== "string" || !CONTROL_ID_RE.test(requestId))
  ) {
    return {
      ok: false,
      message: "requestId must use the safe control identifier alphabet",
    };
  }
  const id = requestId === undefined ? randomUUID() : (requestId as string);
  const safeCommand = command as ControlCommand;
  const needsText =
    safeCommand === "prompt" ||
    safeCommand === "steer" ||
    safeCommand === "follow_up";
  if (needsText) {
    if (typeof text !== "string") {
      return { ok: false, message: `${command} requires text` };
    }
    if (utf8Bytes(text) > CONTROL_INJECTED_TEXT_MAX_BYTES) {
      return {
        ok: false,
        message: `text exceeds ${CONTROL_INJECTED_TEXT_MAX_BYTES} bytes`,
      };
    }
    return {
      ok: true,
      request: { kind: "request", id, command: safeCommand, args: { text } },
    };
  }
  if (text !== undefined && text !== "") {
    return { ok: false, message: `${command} does not accept text` };
  }
  return {
    ok: true,
    request: { kind: "request", id, command: safeCommand, args: {} },
  };
}

// ── Small helpers ───────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate to a UTF-8 byte bound without splitting a multi-byte character. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let result = "";
  for (const ch of text) {
    if (utf8Bytes(result + ch) > maxBytes) break;
    result += ch;
  }
  return result;
}

/** Validate an exact routing name (same alphabet as the core server). */
export function isValidRoutingName(value: unknown): value is string {
  return typeof value === "string" && ROUTING_NAME_RE.test(value);
}

// ── Startup allowlist flag ──────────────────────────────────────────────────

/**
 * Parse the single comma-separated `--allow-control-by` flag value.
 * Entries are trimmed; empty entries and invalid routing names fail closed;
 * duplicates are removed preserving first-seen order. An absent flag disables
 * control entirely (the caller handles absence before calling this).
 */
export function parseAllowControlFlag(
  value: unknown,
): { ok: true; names: string[] } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return {
      ok: false,
      message:
        "--allow-control-by must be a comma-separated list of exact routing names",
    };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (!name) {
      return {
        ok: false,
        message: "--allow-control-by contains an empty entry",
      };
    }
    if (!isValidRoutingName(name)) {
      return {
        ok: false,
        message: `--allow-control-by entry ${JSON.stringify(name)} is not a valid routing name`,
      };
    }
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return { ok: true, names };
}

// ── Strict payload parsing ──────────────────────────────────────────────────

export type RequestParseResult =
  | { status: "ok"; request: ControlRequest }
  | {
      status: "reject";
      id: string;
      command: string;
      code: "malformed_request" | "unsupported_command";
      message: string;
    }
  | { status: "drop"; message: string };

/**
 * Strictly parse a control request payload. `drop` means no well-formed
 * response can be built (invalid id, non-object, wrong kind, invalid command
 * type); the caller drops the frame with a bounded warning. `reject` means a
 * well-formed rejection response can be emitted (valid id; the command is
 * echoed verbatim, so an unsupported command rejection carries the request's
 * own command string). Unknown or extra fields are rejected even though the
 * generic core custom envelope permits additional properties.
 */
export function parseControlRequestPayload(value: unknown): RequestParseResult {
  if (!isPlainObject(value)) {
    return { status: "drop", message: "control request must be a JSON object" };
  }
  const payload = value;
  if (payload.kind !== "request") {
    return {
      status: "drop",
      message: `control request kind must be "request"`,
    };
  }
  const id = payload.id;
  if (typeof id !== "string" || !CONTROL_ID_RE.test(id)) {
    return { status: "drop", message: "control request id is invalid" };
  }
  const command = payload.command;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > CONTROL_COMMAND_MAX
  ) {
    return { status: "drop", message: "control request command is invalid" };
  }
  if (!(CONTROL_COMMANDS as readonly string[]).includes(command)) {
    return {
      status: "reject",
      id,
      command,
      code: "unsupported_command",
      message: `unsupported control command ${JSON.stringify(command)}`,
    };
  }
  // Unknown or extra fields are rejected (with a response) even though the
  // generic core custom envelope permits additional properties.
  if (!hasExactKeys(payload, ["kind", "id", "command", "args"])) {
    return {
      status: "reject",
      id,
      command,
      code: "malformed_request",
      message:
        "control request must contain exactly kind, id, command, and args",
    };
  }
  const args = payload.args;
  if (!isPlainObject(args)) {
    return {
      status: "reject",
      id,
      command,
      code: "malformed_request",
      message: "control request args must be an object",
    };
  }
  const typed = command as ControlCommand;
  const requiresText =
    typed === "prompt" || typed === "steer" || typed === "follow_up";
  if (requiresText) {
    if (!hasExactKeys(args, ["text"])) {
      return {
        status: "reject",
        id,
        command,
        code: "malformed_request",
        message: "control request args must contain exactly text",
      };
    }
    const text = args.text;
    if (typeof text !== "string") {
      return {
        status: "reject",
        id,
        command,
        code: "malformed_request",
        message: "control request text must be a string",
      };
    }
    if (utf8Bytes(text) > CONTROL_INJECTED_TEXT_MAX_BYTES) {
      return {
        status: "reject",
        id,
        command,
        code: "malformed_request",
        message: `control request text exceeds ${CONTROL_INJECTED_TEXT_MAX_BYTES} bytes`,
      };
    }
    return {
      status: "ok",
      request: { id, command: typed, args, text },
    };
  }
  if (!hasExactKeys(args, [])) {
    return {
      status: "reject",
      id,
      command,
      code: "malformed_request",
      message: "control request args must be empty for this command",
    };
  }
  return {
    status: "ok",
    request: { id, command: typed, args, text: null },
  };
}

/** Strictly parse a control response payload (controller-side classification). */
export function parseControlResponsePayload(
  value: unknown,
): { ok: true; response: ControlResponse } | { ok: false; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, message: "control response must be a JSON object" };
  }
  const payload = value;
  if (
    !hasExactKeys(payload, [
      "kind",
      "id",
      "command",
      "phase",
      "sequence",
      "data",
      "error",
    ])
  ) {
    return {
      ok: false,
      message:
        "control response must contain exactly kind, id, command, phase, sequence, data, and error",
    };
  }
  if (payload.kind !== "response") {
    return { ok: false, message: 'control response kind must be "response"' };
  }
  const id = payload.id;
  if (typeof id !== "string" || !CONTROL_ID_RE.test(id)) {
    return { ok: false, message: "control response id is invalid" };
  }
  const command = payload.command;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > CONTROL_COMMAND_MAX
  ) {
    return { ok: false, message: "control response command is invalid" };
  }
  const phase = payload.phase;
  if (
    typeof phase !== "string" ||
    !(CONTROL_PHASES as readonly string[]).includes(phase)
  ) {
    return { ok: false, message: "control response phase is invalid" };
  }
  const sequence = payload.sequence;
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 0
  ) {
    return { ok: false, message: "control response sequence is invalid" };
  }
  const data = payload.data;
  if (!isPlainObject(data)) {
    return { ok: false, message: "control response data must be an object" };
  }
  const error = payload.error;
  let parsedError: { code: string; message: string } | null = null;
  if (error !== null) {
    if (
      !isPlainObject(error) ||
      !hasExactKeys(error, ["code", "message"]) ||
      typeof error.code !== "string" ||
      !(CONTROL_ERROR_CODES as readonly string[]).includes(error.code) ||
      error.code.length > CONTROL_ERROR_CODE_MAX ||
      typeof error.message !== "string" ||
      utf8Bytes(error.message) > CONTROL_ERROR_MESSAGE_MAX_BYTES
    ) {
      return { ok: false, message: "control response error is invalid" };
    }
    parsedError = { code: error.code, message: error.message };
  }
  const phaseRequiresError = phase === "rejected" || phase === "failed";
  if (phaseRequiresError !== (parsedError !== null)) {
    return {
      ok: false,
      message: "control response phase and error do not agree",
    };
  }
  return {
    ok: true,
    response: {
      kind: "response",
      id,
      command,
      phase: phase as ControlPhase,
      sequence,
      data,
      error: parsedError,
    },
  };
}

// ── Final assistant outcome ─────────────────────────────────────────────────

type FinalOutcome =
  | { kind: "text"; text: string; bytes: number; truncated: boolean }
  | { kind: "error"; message: string }
  | { kind: "aborted" }
  | { kind: "no-text" };

function isAssistantMessage(message: unknown): message is {
  role: string;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
} {
  return (
    isPlainObject(message) &&
    (message as { role?: unknown }).role === "assistant"
  );
}

/**
 * Describe the retained final assistant message honestly: only `text` content
 * blocks are extracted (never thinking, tool calls/arguments/results, system
 * prompts, or transcript history), bounded to the final-text cap with explicit
 * truncation metadata and the original UTF-8 byte length. A provider/agent
 * error or abort is reported as such rather than as successful text.
 */
export function describeFinalAssistant(message: unknown): FinalOutcome {
  if (!isAssistantMessage(message)) return { kind: "no-text" };
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason : "";
  const errorMessage =
    typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (stopReason === "error" || errorMessage) {
    return {
      kind: "error",
      message: truncateUtf8(
        errorMessage || `agent run failed (${stopReason || "error"})`,
        CONTROL_ERROR_MESSAGE_MAX_BYTES,
      ),
    };
  }
  if (stopReason === "aborted") return { kind: "aborted" };
  const blocks = Array.isArray(message.content) ? message.content : [];
  const textParts: string[] = [];
  for (const block of blocks) {
    if (
      isPlainObject(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      textParts.push(block.text);
    }
  }
  const raw = textParts.join("\n");
  if (!raw) return { kind: "no-text" };
  const bytes = utf8Bytes(raw);
  let text = raw;
  let truncated = false;
  if (bytes > CONTROL_FINAL_TEXT_MAX_BYTES) {
    text = truncateUtf8(raw, CONTROL_FINAL_TEXT_MAX_BYTES);
    truncated = true;
  }
  return { kind: "text", text, bytes, truncated };
}

// ── Engine host ─────────────────────────────────────────────────────────────

/**
 * Runtime facts and actions the engine needs from the Pi extension. All
 * agent/abort/shutdown interaction uses released public Pi extension APIs; the
 * implementation in `src/index.ts` owns the real wiring.
 */
export interface ControlHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  isStreaming(): boolean;
  isListenerReady(): boolean;
  selfName(): string | null;
  /** Fire-and-forget public Pi submission; admission is not observable here. */
  sendUserMessage(
    text: string,
    deliverAs: "steer" | "followUp" | undefined,
  ): void;
  abort(): void;
  shutdown(): void;
  /** Send one response over the target's persistent connection. Returns true only for a local `submitted` ack. */
  submitControlResponse(
    controller: string,
    payload: ControlResponse,
  ): Promise<boolean>;
  notifyWarning(body: string): void;
}

export interface ControlEngineOptions {
  /** Injectable timer seam for deterministic lifecycle tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
  promptStartTimeoutMs?: number;
}

export interface ControlControllerHost {
  isListenerReady(): boolean;
  submitControlRequest(
    target: string,
    payload: ControlWireRequest,
  ): Promise<boolean>;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendResult(
    message: {
      customType: string;
      content: string;
      display: true;
      details: Record<string, unknown>;
    },
    triggerTurn: boolean,
  ): void;
  notify(body: string, type?: "info" | "warning" | "error"): void;
  schedule(fn: () => void, ms: number): () => void;
}

export interface ControlToolResult {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
}

interface ControllerPending {
  target: string;
  command: ControlCommand;
  request: ControlWireRequest;
  accepted: boolean;
  timedOut: boolean;
  initialDone: boolean;
  resolveInitial: (result: ControlToolResult) => void;
  timerCancel: (() => void) | null;
}

/** Controller-side request registry and terminal-result delivery coordinator. */
export class ControlController {
  private readonly pending = new Map<string, ControllerPending>();
  private terminalQueue: ControlResponse[] = [];
  private resultTurnPending = false;
  private generation = 0;

  constructor(private readonly host: ControlControllerHost) {}

  async execute(
    target: unknown,
    command: unknown,
    text?: unknown,
    requestId?: unknown,
  ): Promise<ControlToolResult> {
    const built = buildControlRequest(target, command, text, requestId);
    if (built.ok === false) return this.errorResult(built.message);
    if (!this.host.isListenerReady()) {
      return this.errorResult(
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
      );
    }
    if (this.pending.size >= CONTROL_PENDING_REQUESTS_MAX) {
      return this.errorResult("too many control requests are pending");
    }
    if (this.pending.has(built.request.id)) {
      return this.errorResult(
        "requestId is already pending; do not retry automatically",
      );
    }
    const request = built.request;
    let resolveInitial!: (result: ControlToolResult) => void;
    const initial = new Promise<ControlToolResult>((resolve) => {
      resolveInitial = resolve;
    });
    const entry: ControllerPending = {
      target: target as string,
      command: request.command,
      request,
      accepted: false,
      timedOut: false,
      initialDone: false,
      resolveInitial,
      timerCancel: null,
    };
    // Register before submitting: a synchronous/fake response cannot race
    // registration and disappear.
    this.pending.set(request.id, entry);
    const generation = this.generation;
    entry.timerCancel = this.host.schedule(() => {
      if (generation !== this.generation || entry.initialDone) return;
      entry.initialDone = true;
      entry.timedOut = true;
      entry.resolveInitial(
        this.errorResult(
          "control request acknowledgement timed out; outcome is unknown; do not retry automatically",
        ),
      );
    }, CONTROL_INITIAL_ACK_TIMEOUT_MS);
    // Submission is deliberately detached from the tool's bounded initial
    // response wait. A hung local helper must not keep the tool call alive past
    // the acknowledgement bound; late responses remain correlated in memory.
    void Promise.resolve()
      .then(() => this.host.submitControlRequest(entry.target, request))
      .then(
        (submitted) => {
          if (!submitted && !entry.initialDone) {
            entry.initialDone = true;
            entry.timedOut = true;
            entry.timerCancel?.();
            entry.resolveInitial(
              this.errorResult(
                "control request outcome is unknown because submission was not confirmed; do not retry automatically",
              ),
            );
          }
        },
        () => {
          if (!entry.initialDone) {
            entry.initialDone = true;
            entry.timedOut = true;
            entry.timerCancel?.();
            entry.resolveInitial(
              this.errorResult(
                "control request outcome is unknown because submission failed; do not retry automatically",
              ),
            );
          }
        },
      );
    return initial;
  }

  handleResponse(response: ControlResponse, fromName?: string): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    if (fromName !== entry.target) return;
    if (response.command !== entry.command) return;
    if (response.phase === "accepted" || response.phase === "started") {
      entry.accepted = true;
      if (response.phase === "accepted") {
        this.notifyStatus(entry, "accepted");
      } else {
        this.notifyStatus(entry, "started");
      }
      // State has an immediate terminal response and is the one command whose
      // tool call may return that terminal payload directly.
      if (!entry.initialDone && entry.command !== "state") {
        entry.initialDone = true;
        entry.timerCancel?.();
        entry.resolveInitial(this.acceptedResult(entry, response));
      }
      return;
    }
    const terminal =
      response.phase === "settled" ||
      response.phase === "failed" ||
      response.phase === "rejected";
    if (!terminal) return;
    if (!entry.accepted && !entry.initialDone) {
      entry.initialDone = true;
      entry.timerCancel?.();
      entry.resolveInitial(
        response.phase === "settled"
          ? this.terminalResult(entry, response)
          : this.errorResult(this.responseError(response)),
      );
      this.pending.delete(response.id);
      return;
    }
    entry.timerCancel?.();
    this.pending.delete(response.id);
    if (!entry.accepted && !entry.timedOut) return;
    if (!entry.initialDone) {
      entry.initialDone = true;
      entry.timerCancel?.();
      entry.resolveInitial(
        response.phase === "rejected" || response.phase === "failed"
          ? this.errorResult(this.responseError(response))
          : entry.command === "state"
            ? this.terminalResult(entry, response)
            : this.acceptedResult(entry, response),
      );
    }
    if (entry.command !== "state" || entry.timedOut)
      this.deliverTerminal(entry, response);
  }

  private notifyStatus(
    entry: ControllerPending,
    phase: "accepted" | "started",
  ): void {
    this.host.notify(
      `control ${phase}: target ${entry.target}, command ${entry.command}, request ${entry.request.id}`,
    );
  }

  private acceptedResult(
    entry: ControllerPending,
    response: ControlResponse,
  ): ControlToolResult {
    return {
      content: [
        {
          type: "text",
          text: `Control request ${entry.request.id} accepted (${response.command})`,
        },
      ],
      details: {
        requestId: entry.request.id,
        target: entry.target,
        command: response.command,
        phase: response.phase,
      },
    };
  }

  private responseError(response: ControlResponse): string {
    return response.error
      ? `${response.error.code}: ${response.error.message}`
      : `control request ${response.phase}`;
  }

  private deliverTerminal(
    entry: ControllerPending,
    response: ControlResponse,
  ): void {
    if (
      this.host.isIdle() &&
      !this.host.hasPendingMessages() &&
      this.terminalQueue.length === 0 &&
      !this.resultTurnPending
    ) {
      this.resultTurnPending = true;
      this.host.sendResult(this.resultMessage(entry, response), true);
      return;
    }
    if (this.terminalQueue.length >= CONTROL_RESPONSE_QUEUE_MAX) {
      const dropped = this.terminalQueue.shift();
      if (dropped) this.terminalEntries.delete(dropped.id);
      this.host.notify(
        "control result queue full; dropped the oldest result",
        "warning",
      );
    }
    this.terminalQueue.push(response);
    this.terminalEntries.set(response.id, entry);
  }

  private readonly terminalEntries = new Map<string, ControllerPending>();

  onAgentSettled(): void {
    if (!this.host.isIdle() || this.host.hasPendingMessages()) return;
    // The controller turn triggered by the prior terminal result is complete;
    // a queued burst may now trigger exactly one fresh turn.
    this.resultTurnPending = false;
    if (this.terminalQueue.length === 0) return;
    const queue = this.terminalQueue.splice(0);
    const entries = queue
      .map((response) => this.terminalEntries.get(response.id))
      .filter((entry): entry is ControllerPending => entry !== undefined);
    for (const response of queue) this.terminalEntries.delete(response.id);
    const triggerFirst = !this.resultTurnPending;
    entries.forEach((entry, index) => {
      const response = queue[index];
      this.host.sendResult(
        this.resultMessage(entry, response),
        triggerFirst && index === 0,
      );
    });
    this.resultTurnPending = true;
  }

  onSessionShutdown(
    reason: "target_reloading" | "target_disconnected" = "target_disconnected",
  ): void {
    this.generation += 1;
    const message =
      reason === "target_reloading"
        ? "target is reloading; no operation resumed after reload"
        : "target inter-agent connection is gone";
    for (const entry of this.pending.values()) {
      entry.timerCancel?.();
      if (!entry.initialDone) {
        entry.initialDone = true;
        entry.resolveInitial(this.errorResult(`${reason}: ${message}`));
      }
    }
    this.pending.clear();
    this.terminalQueue = [];
    this.terminalEntries.clear();
    this.resultTurnPending = false;
  }

  private terminalResult(
    entry: ControllerPending,
    response: ControlResponse,
  ): ControlToolResult {
    return {
      content: [
        {
          type: "text",
          text: response.error
            ? this.responseError(response)
            : `Control request ${entry.request.id} settled`,
        },
      ],
      details: {
        requestId: response.id,
        target: entry.target,
        command: response.command,
        phase: response.phase,
        data: response.data,
        error: response.error,
      },
    };
  }

  private resultMessage(
    entry: ControllerPending,
    response: ControlResponse,
  ): {
    customType: string;
    content: string;
    display: true;
    details: Record<string, unknown>;
  } {
    const details: Record<string, unknown> = {
      requestId: response.id,
      target: entry.target,
      command: response.command,
      phase: response.phase,
      sequence: response.sequence,
      data: response.data,
      error: response.error,
    };
    const body = response.error
      ? `${response.error.code}: ${response.error.message}`
      : typeof response.data.text === "string"
        ? response.data.text
        : response.data.resultUnavailable
          ? "No final assistant text was available."
          : JSON.stringify(response.data);
    return {
      customType: CONTROL_RESULT_CUSTOM_TYPE,
      content: `[inter-agent control result]\nTarget: ${entry.target}\nCommand: ${response.command}\nRequest: ${response.id}\nPhase: ${response.phase}\n\n${body}`,
      display: true,
      details,
    };
  }

  private errorResult(message: string): ControlToolResult {
    return {
      content: [{ type: "text", text: message }],
      details: { error: message },
    };
  }
}

// ── Engine internals ────────────────────────────────────────────────────────

interface DedupRecord {
  id: string;
  command: string;
  phase: ControlPhase;
  sequence: number;
  data: Record<string, unknown>;
  error: ControlResponse["error"];
  terminal: boolean;
}

interface AbortRecord {
  id: string;
  controller: string;
  /** Next response sequence for this abort request. */
  sequence: number;
  started: boolean;
  /** Whether this manual abort preceded the observed activity window. */
  beforeWindowStart: boolean;
}

interface StandaloneAbortOperation {
  requests: AbortRecord[];
  abortApplied: boolean;
  settledPending: boolean;
}

interface ActivityRequest {
  id: string;
  command: ControlCommand;
  controller: string;
  /** Next response sequence after accepted (or started for the prompt). */
  sequence: number;
}

interface ActiveOperation {
  /** The first request opened this shared public activity window. */
  id: string;
  command: ControlCommand;
  controller: string;
  /** Next response sequence for the primary request. */
  sequence: number;
  /** Additional steer/follow_up requests settled against this same window. */
  joined: ActivityRequest[];
  /** Number of public actions currently being invoked synchronously. */
  actionPending: number;
  /** Set when agent_settled arrives before all local submissions finish. */
  settledPending: boolean;
  /** True after the public abort action has been invoked. */
  abortApplied: boolean;
  /** True when the first abort was requested before the activity window start. */
  preStartAbort: boolean;
  /** True after one manual abort has been invoked after activity started. */
  postStartAbortApplied: boolean;
  /** True after the next associated public agent_start was observed. */
  windowStarted: boolean;
  /** Prevent duplicate prompt started responses. */
  startedSent: boolean;
  /** True if lifecycle events arrived during the public action call. */
  startObserved: boolean;
  /** Cancel handle for the bounded prompt-start deadline. */
  startTimerCancel: (() => void) | null;
  interleaved: boolean;
  candidateFinal: unknown;
  abortRequests: AbortRecord[];
}

interface QueuedResponse {
  controller: string;
  payload: ControlResponse;
}

/**
 * Target-side control engine. Serializes dispatch, permits at most one
 * completion-tracked run-affecting remote operation, allows `state` during
 * active work, grants abort/shutdown to any allowlisted controller, and keeps
 * all state process-local and bounded.
 */
export class ControlEngine {
  private enabled = false;
  private allowlist: Set<string> = new Set();
  private shuttingDown = false;
  private active: ActiveOperation | null = null;
  private standaloneAbort: StandaloneAbortOperation | null = null;
  private dedup = new Map<string, Map<string, DedupRecord>>();
  private responseQueue: QueuedResponse[] = [];
  /** Bumped on cleanup so late lifecycle callbacks cannot requeue state. */
  private generation = 0;
  /** Defers lifecycle settlement/start responses across synchronous public calls. */
  private actionDepth = 0;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly promptStartTimeoutMs: number;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly host: ControlHost,
    options: ControlEngineOptions = {},
  ) {
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.promptStartTimeoutMs =
      options.promptStartTimeoutMs ?? CONTROL_PROMPT_START_TIMEOUT_MS;
    // Observe run lifecycle and input through released public Pi events.
    // `agent_settled` is the single terminal settle authority (after retries,
    // compaction, and queued continuations); index.ts registers its own
    // mailbox settle handler independently.
    pi.on("agent_start", () => {
      this.onAgentStart();
    });
    pi.on("agent_end", (event: { messages: unknown[] }) => {
      this.observeAgentEnd(event.messages);
    });
    pi.on("message_end", (event: { message: unknown }) => {
      this.observeMessageEnd(event.message);
    });
    pi.on("input", (event: { text: string; source: string }) => {
      // Released Pi exposes only source and text. Interactive/RPC input is
      // observable interleaving; extension provenance remains unknown.
      this.onInput(event.text, event.source);
    });
    pi.on("agent_settled", () => {
      this.onAgentSettled();
    });
  }

  // ── Lifecycle wiring ──────────────────────────────────────────────────────

  /**
   * Re-apply the startup allowlist flag for a session start. An absent flag
   * disables control completely; an explicitly present but empty or invalid
   * value fails closed and returns a bounded error message for the caller to
   * surface.
   */
  onSessionStart(
    reason: string | undefined,
    allowControlBy: unknown,
  ): { ok: boolean; message?: string } {
    this.generation += 1;
    this.shuttingDown = false;
    this.cancelPromptStartDeadline(this.active);
    this.active = null;
    this.standaloneAbort = null;
    this.dedup.clear();
    this.responseQueue = [];
    if (allowControlBy === undefined || allowControlBy === null) {
      this.enabled = false;
      this.allowlist = new Set();
      return { ok: true };
    }
    const parsed = parseAllowControlFlag(allowControlBy);
    if (parsed.ok === false) {
      this.enabled = false;
      this.allowlist = new Set();
      return { ok: false, message: parsed.message };
    }
    this.enabled = true;
    this.allowlist = new Set(parsed.names);
    return { ok: true };
  }

  /** The listener emitted `welcome`: the private bridge is ready, so flush queued responses. */
  onListenerReady(): void {
    if (this.responseQueue.length === 0) return;
    const queue = this.responseQueue;
    this.responseQueue = [];
    for (const entry of queue) {
      void this.host
        .submitControlResponse(entry.controller, entry.payload)
        .then(
          (ok) => {
            if (!ok) {
              this.host.notifyWarning(
                "failed to deliver a queued control response; the controller can replay the request id",
              );
            }
          },
          () => {
            this.host.notifyWarning(
              "failed to deliver a queued control response; the controller can replay the request id",
            );
          },
        );
    }
  }

  /** Explicit `/inter-agent disconnect` or rename: fail active work and clear tracking. */
  onExplicitDisconnect(): void {
    this.cleanupTracking("target_disconnected");
  }

  /**
   * Session shutdown. Same-process reload fails active work with
   * `target_reloading` and clears all control tracking; other shutdown reasons
   * fail with `target_disconnected`. Best-effort failure responses are sent
   * before tracking is cleared; the caller must invoke this before stopping
   * the listener so the bridge is still available.
   */
  onSessionShutdown(reason: string | undefined): void {
    if (reason === "reload") {
      this.cleanupTracking("target_reloading");
    } else {
      this.cleanupTracking("target_disconnected");
    }
  }

  /** Inbound `pi.control.v1` frame entry point (never an ordinary mailbox message). */
  handleInboundCustomFrame(frame: {
    msgId: string;
    fromName: string;
    customType: string;
    payload: unknown;
  }): void {
    if (frame.customType !== CONTROL_CUSTOM_TYPE) return;
    if (!isPlainObject(frame.payload)) {
      this.host.notifyWarning(
        "ignored a pi.control.v1 frame with a non-object payload",
      );
      return;
    }
    const kind = frame.payload.kind;
    if (kind === "request") {
      this.handleRequest(frame.fromName, frame.payload);
      return;
    }
    if (kind === "response") {
      this.handleResponse(frame.payload, frame.fromName);
      return;
    }
    const label =
      typeof kind === "string" ? truncateUtf8(kind, 64) : "non-string";
    this.host.notifyWarning(
      `ignored a pi.control.v1 frame with unknown kind ${JSON.stringify(label)}`,
    );
  }

  // ── Request handling ──────────────────────────────────────────────────────

  private handleRequest(fromName: string, raw: unknown): void {
    const parsed = parseControlRequestPayload(raw);
    if (parsed.status === "drop") {
      this.host.notifyWarning(
        `dropped a malformed control request: ${parsed.message}`,
      );
      return;
    }
    const id = parsed.status === "ok" ? parsed.request.id : parsed.id;
    const command =
      parsed.status === "ok" ? parsed.request.command : parsed.command;
    // Schema validation precedes authorization (plan ordering: schema,
    // authorization, duplicate, state), so a malformed request is rejected as
    // such regardless of sender.
    if (parsed.status === "reject") {
      this.emitRejection(fromName, id, command, parsed.code, parsed.message);
      return;
    }
    // Authorization uses only the server-supplied envelope from_name; payload
    // identity fields never exist (strict parsing) and are never consulted.
    if (!this.authorized(fromName)) {
      const message = this.enabled
        ? "sender routing name is not allowlisted for control"
        : "control is disabled on this target";
      this.emitRejection(fromName, id, command, "unauthorized", message);
      return;
    }
    // Deduplication replay must not execute again.
    const record = this.lookupRecord(fromName, id);
    if (record) {
      this.replayRecord(fromName, record);
      return;
    }
    this.dispatch(fromName, parsed.request);
  }

  private authorized(fromName: string): boolean {
    if (!this.enabled) return false;
    return isValidRoutingName(fromName) && this.allowlist.has(fromName);
  }

  private dispatch(fromName: string, request: ControlRequest): void {
    switch (request.command) {
      case "prompt":
      case "steer":
      case "follow_up":
        this.dispatchInjection(fromName, request);
        break;
      case "abort":
        this.dispatchAbort(fromName, request);
        break;
      case "state":
        this.dispatchState(fromName, request);
        break;
      case "shutdown":
        this.dispatchShutdown(fromName, request);
        break;
    }
  }

  private dispatchInjection(fromName: string, request: ControlRequest): void {
    if (this.shuttingDown) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "shutting_down",
        "target is shutting down",
      );
      return;
    }
    if (this.standaloneAbort !== null) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "busy",
        "an abort operation is already active",
      );
      return;
    }

    if (request.command === "prompt") {
      if (this.active !== null) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "another remote activity window is already active",
        );
        return;
      }
      if (!this.isFullyIdle()) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "agent is not fully idle",
        );
        return;
      }
      const operation = this.newOperation(fromName, request, false);
      this.active = operation;
      this.invokeSubmission(operation, request, undefined, null, fromName);
      return;
    }

    // A steer/follow_up joins the currently active public activity window. If
    // human work is already running, it opens a shared window anchored to that
    // observed run; Pi exposes no distinct public start for the mutation.
    if (this.active !== null) {
      if (!this.active.windowStarted) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "the remote activity window has not started",
        );
        return;
      }
      if (this.active.joined.length >= CONTROL_JOINED_REQUESTS_MAX) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "the shared activity window has reached its request limit",
        );
        return;
      }
      this.invokeSubmission(
        this.active,
        request,
        request.command === "steer" ? "steer" : "followUp",
        this.active,
        fromName,
      );
      return;
    }
    if (this.isFullyIdle()) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "invalid_state",
        "no active agent run; use prompt to start one",
      );
      return;
    }
    const operation = this.newOperation(fromName, request, true);
    this.active = operation;
    this.invokeSubmission(
      operation,
      request,
      request.command === "steer" ? "steer" : "followUp",
      null,
      fromName,
    );
  }

  private newOperation(
    fromName: string,
    request: ControlRequest,
    windowAlreadyStarted: boolean,
  ): ActiveOperation {
    return {
      id: request.id,
      command: request.command,
      controller: fromName,
      sequence: 1,
      joined: [],
      actionPending: 0,
      settledPending: false,
      abortApplied: false,
      preStartAbort: false,
      postStartAbortApplied: false,
      windowStarted: windowAlreadyStarted,
      startedSent: windowAlreadyStarted || request.command !== "prompt",
      startObserved: windowAlreadyStarted,
      startTimerCancel: null,
      interleaved: false,
      candidateFinal: null,
      abortRequests: [],
    };
  }

  /** Invoke released fire-and-forget sendUserMessage and then report local submission. */
  private invokeSubmission(
    operation: ActiveOperation,
    request: ControlRequest,
    deliverAs: "steer" | "followUp" | undefined,
    existingOperation: ActiveOperation | null,
    fromName: string,
  ): void {
    const joined = existingOperation !== null;
    const record: ActivityRequest = {
      id: request.id,
      command: request.command,
      controller: fromName,
      sequence: 1,
    };
    if (joined) {
      operation.joined.push(record);
    }
    operation.actionPending += 1;
    this.actionDepth += 1;
    let thrown: unknown = null;
    try {
      this.host.sendUserMessage(request.text ?? "", deliverAs);
    } catch (error) {
      thrown = error;
    } finally {
      this.actionDepth -= 1;
      operation.actionPending -= 1;
    }

    if (thrown !== null) {
      if (joined) {
        operation.joined = operation.joined.filter((entry) => entry !== record);
      } else if (this.active === operation) {
        this.clearActive();
      }
      const message = truncateUtf8(
        thrown instanceof Error
          ? thrown.message
          : typeof thrown === "string"
            ? thrown
            : "Pi did not accept the control action",
        CONTROL_ERROR_MESSAGE_MAX_BYTES,
      );
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "operation_failed",
        message || "Pi did not accept the control action",
      );
      if (joined) this.flushDeferredLifecycle(operation);
      return;
    }

    this.sendResponse(
      fromName,
      this.buildResponse(
        request.id,
        request.command,
        "accepted",
        0,
        { submission: "local" },
        null,
      ),
      true,
    );
    if (!joined && request.command === "prompt") {
      this.armPromptStartDeadline(operation);
    }
    this.flushDeferredLifecycle(operation);
  }

  private armPromptStartDeadline(operation: ActiveOperation): void {
    if (
      this.active !== operation ||
      operation.command !== "prompt" ||
      operation.windowStarted ||
      operation.startTimerCancel !== null
    ) {
      return;
    }
    const generation = this.generation;
    operation.startTimerCancel = this.schedule(() => {
      operation.startTimerCancel = null;
      if (
        this.active !== operation ||
        generation !== this.generation ||
        operation.windowStarted
      ) {
        return;
      }
      this.finalizeUnknownOutcome(operation);
    }, this.promptStartTimeoutMs);
  }

  private cancelPromptStartDeadline(operation: ActiveOperation | null): void {
    if (!operation?.startTimerCancel) return;
    const cancel = operation.startTimerCancel;
    operation.startTimerCancel = null;
    cancel();
  }

  private flushDeferredLifecycle(operation: ActiveOperation): void {
    if (this.active !== operation || this.actionDepth !== 0) return;
    if (operation.startObserved && !operation.startedSent) {
      this.emitActivityStarted(operation);
    }
    if (operation.settledPending && operation.actionPending === 0) {
      operation.settledPending = false;
      this.onAgentSettled();
    }
  }

  private emitActivityStarted(operation: ActiveOperation): void {
    if (
      this.active !== operation ||
      operation.startedSent ||
      operation.command !== "prompt" ||
      !operation.windowStarted
    ) {
      return;
    }
    operation.startedSent = true;
    this.sendResponse(
      operation.controller,
      this.buildResponse(
        operation.id,
        operation.command,
        "started",
        operation.sequence++,
        { attribution: "activity_window" },
        null,
      ),
      true,
    );
  }

  private startAbortRequests(requests: AbortRecord[]): void {
    for (const abort of requests) {
      if (abort.started) continue;
      abort.started = true;
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "started",
          abort.sequence++,
          {},
          null,
        ),
        true,
      );
    }
  }

  private dispatchAbort(fromName: string, request: ControlRequest): void {
    if (this.shuttingDown) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "shutting_down",
        "target is shutting down",
      );
      return;
    }
    const record: AbortRecord = {
      id: request.id,
      controller: fromName,
      sequence: 1,
      started: false,
      beforeWindowStart: false,
    };

    if (this.active !== null) {
      const operation = this.active;
      if (operation.abortRequests.length >= CONTROL_ABORT_REQUESTS_MAX) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "too many abort requests are already pending",
        );
        return;
      }
      record.beforeWindowStart = !operation.windowStarted;
      if (record.beforeWindowStart) operation.preStartAbort = true;
      operation.abortRequests.push(record);
      const invokeAbort = record.beforeWindowStart
        ? !operation.abortApplied
        : !operation.postStartAbortApplied;
      let thrown: unknown = null;
      if (invokeAbort) {
        this.actionDepth += 1;
        try {
          this.host.abort();
          if (record.beforeWindowStart) {
            operation.abortApplied = true;
          } else {
            operation.postStartAbortApplied = true;
          }
        } catch (error) {
          thrown = error;
        } finally {
          this.actionDepth -= 1;
        }
      }
      if (thrown !== null) {
        operation.abortRequests = operation.abortRequests.filter(
          (entry) => entry !== record,
        );
        operation.preStartAbort = operation.abortRequests.some(
          (entry) => entry.beforeWindowStart,
        );
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "operation_failed",
          thrown instanceof Error
            ? truncateUtf8(thrown.message, CONTROL_ERROR_MESSAGE_MAX_BYTES)
            : "Pi did not accept the abort action",
        );
        return;
      }
      this.sendResponse(
        fromName,
        this.buildResponse(
          request.id,
          "abort",
          "accepted",
          0,
          { submission: "local" },
          null,
        ),
        true,
      );
      this.startAbortRequests(operation.abortRequests);
      this.flushDeferredLifecycle(operation);
      if (
        this.active === operation &&
        operation.windowStarted &&
        this.isFullyIdle()
      ) {
        this.finalizeAbortPair();
      }
      return;
    }

    if (this.standaloneAbort !== null) {
      const standalone = this.standaloneAbort;
      if (standalone.requests.length >= CONTROL_ABORT_REQUESTS_MAX) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "too many abort requests are already pending",
        );
        return;
      }
      standalone.requests.push(record);
      this.sendResponse(
        fromName,
        this.buildResponse(request.id, "abort", "accepted", 0, {}, null),
        true,
      );
      this.startAbortRequests(standalone.requests);
      if (standalone.settledPending && this.actionDepth === 0) {
        standalone.settledPending = false;
        this.finalizeStandaloneAbort();
      }
      return;
    }

    if (this.isFullyIdle()) {
      // Fully idle aborts are successful no-ops. A non-idle host with no
      // remote operation is human-initiated work and follows the same
      // settlement authority as a remote run.
      this.sendResponse(
        fromName,
        this.buildResponse(request.id, "abort", "accepted", 0, {}, null),
        true,
      );
      this.sendResponse(
        fromName,
        this.buildResponse(request.id, "abort", "settled", 1, {}, null),
        true,
      );
      return;
    }

    const standalone: StandaloneAbortOperation = {
      requests: [record],
      abortApplied: false,
      settledPending: false,
    };
    this.standaloneAbort = standalone;
    let thrown: unknown = null;
    this.actionDepth += 1;
    try {
      this.host.abort();
      standalone.abortApplied = true;
    } catch (error) {
      thrown = error;
    } finally {
      this.actionDepth -= 1;
    }
    if (thrown !== null) {
      this.standaloneAbort = null;
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "operation_failed",
        thrown instanceof Error
          ? truncateUtf8(thrown.message, CONTROL_ERROR_MESSAGE_MAX_BYTES)
          : "Pi did not accept the abort action",
      );
      return;
    }
    this.sendResponse(
      fromName,
      this.buildResponse(
        request.id,
        "abort",
        "accepted",
        0,
        { submission: "local" },
        null,
      ),
      true,
    );
    this.startAbortRequests(standalone.requests);
    if (standalone.settledPending && this.actionDepth === 0) {
      standalone.settledPending = false;
      this.finalizeStandaloneAbort();
    }
  }

  private isFullyIdle(): boolean {
    return (
      this.host.isIdle() &&
      !this.host.hasPendingMessages() &&
      !this.host.isStreaming()
    );
  }

  private dispatchState(fromName: string, request: ControlRequest): void {
    if (this.shuttingDown) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "shutting_down",
        "target is shutting down",
      );
      return;
    }
    this.sendResponse(
      fromName,
      this.buildResponse(request.id, "state", "accepted", 0, {}, null),
      true,
    );
    this.sendResponse(
      fromName,
      this.buildResponse(
        request.id,
        "state",
        "settled",
        1,
        this.buildStateData(),
        null,
      ),
      true,
    );
  }

  private dispatchShutdown(fromName: string, request: ControlRequest): void {
    if (this.shuttingDown) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "shutting_down",
        "target is shutting down",
      );
      return;
    }
    this.shuttingDown = true;
    const wasActive =
      this.active !== null ||
      !this.host.isIdle() ||
      this.host.hasPendingMessages();
    this.sendResponse(
      fromName,
      this.buildResponse(request.id, "shutdown", "accepted", 0, {}, null),
      true,
    );
    this.sendResponse(
      fromName,
      this.buildResponse(
        request.id,
        "shutdown",
        "settled",
        1,
        { shutdownRequested: true, wasActive },
        null,
      ),
      true,
    );
    // Call shutdown regardless of response-delivery success; the target never
    // claims the process exited or the terminal host closed.
    this.host.shutdown();
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  /** The next public agent_start opens the prompt's shared activity window. */
  onAgentStart(): void {
    const op = this.active;
    if (!op) return;
    this.cancelPromptStartDeadline(op);
    if (op.preStartAbort) {
      // The pre-start invocation is no longer an active-window application;
      // observing start never invokes abort again.
      op.abortApplied = false;
    }
    op.windowStarted = true;
    op.startObserved = true;
    if (this.actionDepth === 0) this.flushDeferredLifecycle(op);
  }

  observeMessageEnd(message: unknown): void {
    if (!this.active?.windowStarted) return;
    if (isAssistantMessage(message)) this.active.candidateFinal = message;
  }

  observeAgentEnd(messages: unknown[]): void {
    if (!this.active?.windowStarted || !Array.isArray(messages)) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isAssistantMessage(messages[i])) {
        this.active.candidateFinal = messages[i];
        return;
      }
    }
  }

  onInput(_text: string, source: string): void {
    if (!this.active) return;
    // Released Pi does not expose extension origin. Only interactive/RPC
    // participation is observable; extension participation remains unknown.
    if (source === "interactive" || source === "rpc") {
      this.active.interleaved = true;
    }
  }

  /** The single terminal settle point: `agent_settled` after retries/compaction/queued continuations. */
  onAgentSettled(): void {
    if (this.actionDepth > 0) {
      if (this.standaloneAbort !== null) {
        this.standaloneAbort.settledPending = true;
      } else if (this.active !== null) {
        this.active.settledPending = true;
      }
      return;
    }
    if (this.standaloneAbort !== null) {
      this.finalizeStandaloneAbort();
      return;
    }
    const op = this.active;
    if (!op) return;
    if (op.actionPending > 0) {
      op.settledPending = true;
      return;
    }
    if (!op.windowStarted) {
      this.finalizeUnknownOutcome(op);
      return;
    }
    if (op.abortRequests.length > 0) {
      if (op.preStartAbort) {
        const outcome = describeFinalAssistant(op.candidateFinal);
        if (outcome.kind !== "aborted") {
          this.finalizePreStartAbortRequests(op);
          op.abortRequests = [];
          this.onAgentSettled();
          return;
        }
      }
      this.finalizeAbortPair();
      return;
    }
    const outcome = describeFinalAssistant(op.candidateFinal);
    const dataBase = {
      attribution: "activity_window",
      interleaved: op.interleaved,
    };
    if (outcome.kind === "error") {
      this.sendActivityTerminal(op, "failed", dataBase, {
        code: "operation_failed",
        message: outcome.message,
      });
    } else if (outcome.kind === "aborted") {
      this.sendActivityTerminal(op, "failed", dataBase, {
        code: "operation_aborted",
        message: "agent run aborted",
      });
    } else if (outcome.kind === "text") {
      this.sendActivityTerminal(
        op,
        "settled",
        {
          ...dataBase,
          text: outcome.text,
          bytes: outcome.bytes,
          truncated: outcome.truncated,
        },
        null,
      );
    } else {
      this.sendActivityTerminal(
        op,
        "settled",
        { ...dataBase, resultUnavailable: true, bytes: 0, truncated: false },
        null,
      );
    }
    this.clearActive();
  }

  private finalizePreStartAbortRequests(operation: ActiveOperation): void {
    const data = {
      attribution: "activity_window",
      interleaved: operation.interleaved,
      aborted: false,
    };
    for (const abort of operation.abortRequests) {
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "settled",
          abort.sequence++,
          data,
          null,
        ),
        true,
      );
    }
  }

  private finalizeUnknownOutcome(operation: ActiveOperation): void {
    const data = {
      attribution: "activity_window",
      interleaved: operation.interleaved,
      unknownOutcome: true,
      aborted: false,
    };
    const error = {
      code: "operation_failed" as const,
      message:
        "control action outcome is unknown; no correlated agent_start was observed; do not retry automatically",
    };
    this.sendActivityTerminal(operation, "failed", data, error);
    for (const abort of operation.abortRequests) {
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "failed",
          abort.sequence++,
          data,
          {
            code: "operation_failed",
            message:
              "abort outcome is unknown because no activity window started; do not retry automatically",
          },
        ),
        true,
      );
    }
    this.clearActive();
  }

  private sendActivityTerminal(
    operation: ActiveOperation,
    phase: "settled" | "failed",
    data: Record<string, unknown>,
    error: ControlResponse["error"],
  ): void {
    this.sendResponse(
      operation.controller,
      this.buildResponse(
        operation.id,
        operation.command,
        phase,
        operation.sequence++,
        data,
        error,
      ),
      true,
    );
    for (const joined of operation.joined) {
      this.sendResponse(
        joined.controller,
        this.buildResponse(
          joined.id,
          joined.command,
          phase,
          joined.sequence++,
          data,
          error,
        ),
        true,
      );
    }
  }

  private finalizeStandaloneAbort(): void {
    const standalone = this.standaloneAbort;
    if (!standalone) return;
    this.standaloneAbort = null;
    for (const abort of standalone.requests) {
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "settled",
          abort.sequence++,
          { aborted: true },
          null,
        ),
        true,
      );
    }
  }

  private finalizeAbortPair(): void {
    const op = this.active;
    if (!op) return;
    const data = {
      attribution: "activity_window",
      interleaved: op.interleaved,
    };
    const requests: ActivityRequest[] = [
      {
        id: op.id,
        command: op.command,
        controller: op.controller,
        sequence: op.sequence,
      },
      ...op.joined,
    ];
    // Terminally fail every request that joined the shared interrupted window.
    for (const remote of requests) {
      this.sendResponse(
        remote.controller,
        this.buildResponse(
          remote.id,
          remote.command,
          "failed",
          remote.sequence++,
          data,
          {
            code: "operation_aborted",
            message: "operation aborted by controller",
          },
        ),
        true,
      );
    }
    // Terminally settle every abort request successfully.
    for (const abort of op.abortRequests) {
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "settled",
          abort.sequence++,
          { ...data, aborted: true },
          null,
        ),
        true,
      );
    }
    this.clearActive();
  }

  private clearActive(): void {
    this.cancelPromptStartDeadline(this.active);
    this.active = null;
  }

  // ── Response handling ─────────────────────────────────────────────────────

  private responseHandler:
    | ((response: ControlResponse, fromName?: string) => void)
    | null = null;

  /** Attach the controller-side pending-response registry without changing target dispatch. */
  setResponseHandler(
    handler: ((response: ControlResponse, fromName?: string) => void) | null,
  ): void {
    this.responseHandler = handler;
  }

  private handleResponse(raw: unknown, fromName?: string): void {
    const parsed = parseControlResponsePayload(raw);
    if (parsed.ok === false) {
      this.host.notifyWarning(
        `ignored a malformed control response: ${parsed.message}`,
      );
      return;
    }
    // Valid responses are classified before ordinary mailbox processing and
    // handed to the controller-side registry. They never become mailbox items.
    this.responseHandler?.(parsed.response, fromName);
  }

  // ── Responses, dedup, and reconnect queue ─────────────────────────────────

  private buildResponse(
    id: string,
    command: string,
    phase: ControlPhase,
    sequence: number,
    data: Record<string, unknown>,
    error: ControlResponse["error"],
  ): ControlResponse {
    return { kind: "response", id, command, phase, sequence, data, error };
  }

  private emitRejection(
    controller: string,
    id: string,
    command: string,
    code: ControlErrorCode,
    message: string,
  ): void {
    this.sendResponse(
      controller,
      this.buildResponse(
        id,
        command,
        "rejected",
        0,
        {},
        {
          code,
          message: truncateUtf8(message, CONTROL_ERROR_MESSAGE_MAX_BYTES),
        },
      ),
      true,
    );
  }

  private buildStateData(): Record<string, unknown> {
    const lifecycle = this.shuttingDown
      ? "shutting_down"
      : this.active !== null ||
          this.standaloneAbort !== null ||
          !this.host.isIdle() ||
          this.host.hasPendingMessages()
        ? "busy"
        : "idle";
    const data: Record<string, unknown> = {
      name: this.host.selfName(),
      controlEnabled: this.enabled,
      lifecycle,
      pendingMessages: this.host.hasPendingMessages(),
      allowlistCount: this.allowlist.size,
      listenerReady: this.host.isListenerReady(),
      activeRequest:
        this.active !== null
          ? {
              id: this.active.id,
              command: this.active.command,
              controller: this.active.controller,
            }
          : this.standaloneAbort?.requests[0]
            ? {
                id: this.standaloneAbort.requests[0].id,
                command: "abort",
                controller: this.standaloneAbort.requests[0].controller,
              }
            : null,
    };
    return data;
  }

  private sendResponse(
    controller: string,
    payload: ControlResponse,
    record: boolean,
    queue = true,
  ): void {
    if (record) this.storeRecord(controller, payload);
    this.deliverOrQueue(controller, payload, queue);
  }

  private deliverOrQueue(
    controller: string,
    payload: ControlResponse,
    queue: boolean,
  ): void {
    if (this.host.isListenerReady() && this.host.selfName() !== null) {
      if (!queue) {
        void this.host.submitControlResponse(controller, payload);
        return;
      }
      const gen = this.generation;
      void this.host.submitControlResponse(controller, payload).then(
        (ok) => {
          if (!ok && gen === this.generation) {
            this.enqueueResponse(controller, payload);
          }
        },
        () => {
          if (gen === this.generation) {
            this.enqueueResponse(controller, payload);
          }
        },
      );
      return;
    }
    if (queue) this.enqueueResponse(controller, payload);
  }

  private enqueueResponse(controller: string, payload: ControlResponse): void {
    if (this.responseQueue.length >= CONTROL_RESPONSE_QUEUE_MAX) {
      this.responseQueue.shift();
      this.host.notifyWarning(
        "control response queue full; dropped the oldest unsent response",
      );
    }
    this.responseQueue.push({ controller, payload });
  }

  private storeRecord(controller: string, payload: ControlResponse): void {
    let byId = this.dedup.get(controller);
    if (!byId) {
      byId = new Map();
      this.dedup.set(controller, byId);
    }
    byId.set(payload.id, {
      id: payload.id,
      command: payload.command,
      phase: payload.phase,
      sequence: payload.sequence,
      data: payload.data,
      error: payload.error,
      terminal:
        payload.phase === "settled" ||
        payload.phase === "rejected" ||
        payload.phase === "failed",
    });
    if (byId.size > CONTROL_DEDUP_PER_SENDER) {
      const oldest = byId.keys().next().value;
      if (oldest !== undefined) byId.delete(oldest);
    }
  }

  private lookupRecord(controller: string, id: string): DedupRecord | null {
    return this.dedup.get(controller)?.get(id) ?? null;
  }

  private replayRecord(controller: string, record: DedupRecord): void {
    // Replay the latest known status or terminal result without executing and
    // without refreshing the eviction order.
    this.sendResponse(
      controller,
      this.buildResponse(
        record.id,
        record.command,
        record.phase,
        record.sequence,
        record.data,
        record.error,
      ),
      false,
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Best-effort fail any active request(s), then clear active state, the
   * activity-window state, the outbound response queue, and per-sender
   * deduplication records. Failure responses are sent directly (never queued)
   * so nothing outlives the cleanup.
   */
  private cleanupTracking(
    code: "target_reloading" | "target_disconnected",
  ): void {
    // Bump first so late lifecycle/deadline callbacks from earlier sends can
    // never requeue into the cleared queue.
    this.generation += 1;
    this.cancelPromptStartDeadline(this.active);
    const op = this.active;
    const standalone = this.standaloneAbort;
    if (standalone) {
      for (const abort of standalone.requests) {
        this.sendResponse(
          abort.controller,
          this.buildResponse(
            abort.id,
            "abort",
            "failed",
            abort.sequence++,
            {},
            { code, message: boundedCleanupMessage(code) },
          ),
          true,
          false,
        );
      }
    }
    if (op) {
      const data = {
        attribution: "activity_window",
        interleaved: op.interleaved,
      };
      const remoteRequests: ActivityRequest[] = [
        {
          id: op.id,
          command: op.command,
          controller: op.controller,
          sequence: op.sequence,
        },
        ...op.joined,
      ];
      for (const remote of remoteRequests) {
        this.sendResponse(
          remote.controller,
          this.buildResponse(
            remote.id,
            remote.command,
            "failed",
            remote.sequence++,
            data,
            { code, message: boundedCleanupMessage(code) },
          ),
          true,
          false,
        );
      }
      for (const abort of op.abortRequests) {
        this.sendResponse(
          abort.controller,
          this.buildResponse(
            abort.id,
            "abort",
            "failed",
            abort.sequence++,
            data,
            { code, message: boundedCleanupMessage(code) },
          ),
          true,
          false,
        );
      }
    }
    this.clearActive();
    this.standaloneAbort = null;
    this.responseQueue = [];
    this.dedup.clear();
  }
}

function boundedCleanupMessage(
  code: "target_reloading" | "target_disconnected",
): string {
  return code === "target_reloading"
    ? "target is reloading; no operation resumed after reload"
    : "target inter-agent connection is gone";
}
