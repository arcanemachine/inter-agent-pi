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
 * agent/abort/shutdown interaction uses public Pi extension APIs; the
 * implementation in `src/index.ts` owns the real wiring.
 */
export interface ControlHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  isStreaming(): boolean;
  isListenerReady(): boolean;
  selfName(): string | null;
  /** Resolve only after Pi admits/enqueues the input; reject before run start otherwise. */
  submitUserMessage(
    text: string,
    deliverAs: "steer" | "followUp" | undefined,
  ): Promise<void>;
  abort(): void;
  shutdown(): void;
  /** Send one response over the target's persistent connection. Returns true only for a local `submitted` ack. */
  submitControlResponse(
    controller: string,
    payload: ControlResponse,
  ): Promise<boolean>;
  notifyWarning(body: string): void;
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
}

interface StandaloneAbortOperation {
  requests: AbortRecord[];
  abortApplied: boolean;
}

interface ActiveOperation {
  id: string;
  command: ControlCommand;
  controller: string;
  /** Next response sequence (0 accepted, 1 started, 2 terminal). */
  sequence: number;
  /** True while the public submission promise is awaiting admission. */
  admissionPending: boolean;
  /** True only after the public submission promise resolves. */
  admitted: boolean;
  /** Set when agent_settled arrives before admission resolves. */
  settledPending: boolean;
  /** Prevent duplicate abort calls when admission was initially pending. */
  abortApplied: boolean;
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
  /** Bumped on cleanup so late async submission callbacks cannot requeue. */
  private generation = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly host: ControlHost,
  ) {
    // Observe run lifecycle and input through public Pi events. `agent_settled`
    // is the single terminal settle authority (after retries, compaction, and
    // queued continuations); index.ts registers its own mailbox settle handler
    // independently.
    pi.on("agent_end", (event: { messages: unknown[] }) => {
      this.observeAgentEnd(event.messages);
    });
    pi.on("message_end", (event: { message: unknown }) => {
      this.observeMessageEnd(event.message);
    });
    pi.on(
      "input",
      (event: { text: string; source: string; fromSelf?: boolean }) => {
        // `fromSelf` is the public Pi origin contract. Never infer origin from
        // source, text, timing, or any payload marker.
        this.onInput(event.text, event.source, event.fromSelf === true);
      },
    );
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
      this.handleResponse(frame.payload);
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
    if (this.active !== null || this.standaloneAbort !== null) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "busy",
        "another remote operation is already active",
      );
      return;
    }
    const runActive = !this.host.isIdle() || this.host.hasPendingMessages();
    if (request.command === "prompt") {
      if (runActive) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "agent is not fully idle",
        );
        return;
      }
    } else if (!runActive) {
      this.emitRejection(
        fromName,
        request.id,
        request.command,
        "invalid_state",
        "no active agent run; use prompt to start one",
      );
      return;
    }

    this.sendResponse(
      fromName,
      this.buildResponse(request.id, request.command, "accepted", 0, {}, null),
      true,
    );
    const deliverAs =
      request.command === "prompt"
        ? undefined
        : request.command === "steer"
          ? "steer"
          : "followUp";
    const operation: ActiveOperation = {
      id: request.id,
      command: request.command,
      controller: fromName,
      sequence: 1,
      admissionPending: true,
      admitted: false,
      settledPending: false,
      abortApplied: false,
      interleaved: false,
      candidateFinal: null,
      abortRequests: [],
    };
    // Reserve the operation before entering Pi's asynchronous input pipeline.
    // This serializes concurrent remote injections even while admission is
    // pending, while `submitUserMessage` itself remains the only admission
    // authority.
    this.active = operation;
    let admission: Promise<void>;
    try {
      admission = this.host.submitUserMessage(request.text ?? "", deliverAs);
    } catch (error) {
      admission = Promise.reject(error);
    }
    void admission.then(
      () => this.onSubmissionAdmitted(operation),
      (error: unknown) => this.onSubmissionRejected(operation, error),
    );
  }

  private onSubmissionAdmitted(operation: ActiveOperation): void {
    if (this.active !== operation) return;
    operation.admissionPending = false;
    operation.admitted = true;
    this.sendResponse(
      operation.controller,
      this.buildResponse(
        operation.id,
        operation.command,
        "started",
        operation.sequence++,
        {},
        null,
      ),
      true,
    );
    if (operation.abortRequests.length > 0 && !operation.abortApplied) {
      operation.abortApplied = true;
      this.host.abort();
      this.startAbortRequests(operation.abortRequests);
    }
    if (
      operation.settledPending ||
      (operation.abortApplied && this.isFullyIdle())
    ) {
      this.finishAfterDeferredSettlement(operation);
    }
  }

  private onSubmissionRejected(
    operation: ActiveOperation,
    reason: unknown,
  ): void {
    if (this.active !== operation) return;
    operation.admissionPending = false;
    const reasonText =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Pi did not admit the control input";
    const message = truncateUtf8(reasonText, CONTROL_ERROR_MESSAGE_MAX_BYTES);
    this.sendResponse(
      operation.controller,
      this.buildResponse(
        operation.id,
        operation.command,
        "rejected",
        operation.sequence++,
        {},
        {
          code: "operation_failed",
          message: message || "Pi did not admit the control input",
        },
      ),
      true,
    );
    for (const abort of operation.abortRequests) {
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "settled",
          abort.sequence++,
          { aborted: false },
          null,
        ),
        true,
      );
    }
    this.clearActive();
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
    };

    if (this.active !== null) {
      if (this.active.abortRequests.length >= CONTROL_ABORT_REQUESTS_MAX) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "too many abort requests are already pending",
        );
        return;
      }
      this.active.abortRequests.push(record);
      this.sendResponse(
        fromName,
        this.buildResponse(request.id, "abort", "accepted", 0, {}, null),
        true,
      );
      // Admission must win the race: a pending submitUserMessage can still be
      // rejected or reserved, so apply abort only after it has resolved.
      if (!this.active.admissionPending && !this.active.abortApplied) {
        this.active.abortApplied = true;
        this.host.abort();
      }
      if (this.active.abortApplied) {
        this.startAbortRequests(this.active.abortRequests);
      }
      const operation = this.active;
      if (operation !== null && operation.abortApplied && this.isFullyIdle()) {
        this.finalizeAbortPair();
      }
      return;
    }

    if (this.standaloneAbort !== null) {
      if (this.standaloneAbort.requests.length >= CONTROL_ABORT_REQUESTS_MAX) {
        this.emitRejection(
          fromName,
          request.id,
          request.command,
          "busy",
          "too many abort requests are already pending",
        );
        return;
      }
      this.standaloneAbort.requests.push(record);
      this.sendResponse(
        fromName,
        this.buildResponse(request.id, "abort", "accepted", 0, {}, null),
        true,
      );
      if (!this.standaloneAbort.abortApplied) {
        this.standaloneAbort.abortApplied = true;
        this.host.abort();
      }
      if (this.standaloneAbort.abortApplied) {
        this.startAbortRequests(this.standaloneAbort.requests);
      }
      if (this.isFullyIdle()) this.finalizeStandaloneAbort();
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

    this.standaloneAbort = { requests: [record], abortApplied: false };
    this.sendResponse(
      fromName,
      this.buildResponse(request.id, "abort", "accepted", 0, {}, null),
      true,
    );
    this.standaloneAbort.abortApplied = true;
    this.host.abort();
    this.startAbortRequests(this.standaloneAbort.requests);
    if (this.isFullyIdle()) this.finalizeStandaloneAbort();
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

  observeMessageEnd(message: unknown): void {
    if (!this.active) return;
    if (isAssistantMessage(message)) this.active.candidateFinal = message;
  }

  observeAgentEnd(messages: unknown[]): void {
    if (!this.active || !Array.isArray(messages)) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isAssistantMessage(messages[i])) {
        this.active.candidateFinal = messages[i];
        return;
      }
    }
  }

  onInput(text: string, source: string, fromSelf = false): void {
    void text;
    if (!this.active) return;
    // The host's public fromSelf bit is the only origin signal. An extension
    // submission with identical text is still unrelated when fromSelf=false.
    if (source === "extension" && fromSelf) return;
    this.active.interleaved = true;
  }

  private finishAfterDeferredSettlement(operation: ActiveOperation): void {
    if (this.active !== operation || !operation.admitted) return;
    operation.settledPending = false;
    this.onAgentSettled();
  }

  /** The single terminal settle point: `agent_settled` after retries/compaction/queued continuations. */
  onAgentSettled(): void {
    if (this.standaloneAbort !== null) {
      this.finalizeStandaloneAbort();
      return;
    }
    const op = this.active;
    if (!op) return;
    if (op.admissionPending) {
      // Admission resolves after the input pipeline has accepted the message;
      // do not claim a terminal result or emit started before that point.
      op.settledPending = true;
      return;
    }
    if (op.abortRequests.length > 0) {
      this.finalizeAbortPair();
      return;
    }
    const outcome = describeFinalAssistant(op.candidateFinal);
    const interleaved = op.interleaved;
    if (outcome.kind === "error") {
      this.sendResponse(
        op.controller,
        this.buildResponse(
          op.id,
          op.command,
          "failed",
          op.sequence++,
          { interleaved },
          { code: "operation_failed", message: outcome.message },
        ),
        true,
      );
    } else if (outcome.kind === "aborted") {
      this.sendResponse(
        op.controller,
        this.buildResponse(
          op.id,
          op.command,
          "failed",
          op.sequence++,
          { interleaved },
          { code: "operation_aborted", message: "agent run aborted" },
        ),
        true,
      );
    } else if (outcome.kind === "text") {
      this.sendResponse(
        op.controller,
        this.buildResponse(
          op.id,
          op.command,
          "settled",
          op.sequence++,
          {
            text: outcome.text,
            bytes: outcome.bytes,
            truncated: outcome.truncated,
            interleaved,
          },
          null,
        ),
        true,
      );
    } else {
      this.sendResponse(
        op.controller,
        this.buildResponse(
          op.id,
          op.command,
          "settled",
          op.sequence++,
          { resultUnavailable: true, bytes: 0, truncated: false, interleaved },
          null,
        ),
        true,
      );
    }
    this.clearActive();
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
    const interleaved = op.interleaved;
    // Terminal fail the interrupted request.
    this.sendResponse(
      op.controller,
      this.buildResponse(
        op.id,
        op.command,
        "failed",
        op.sequence++,
        { interleaved },
        {
          code: "operation_aborted",
          message: "operation aborted by controller",
        },
      ),
      true,
    );
    // Terminally settle every abort request successfully.
    for (const abort of op.abortRequests) {
      this.sendResponse(
        abort.controller,
        this.buildResponse(
          abort.id,
          "abort",
          "settled",
          abort.sequence++,
          { aborted: true, interleaved },
          null,
        ),
        true,
      );
    }
    this.clearActive();
  }

  private clearActive(): void {
    this.active = null;
  }

  // ── Response handling ─────────────────────────────────────────────────────

  private handleResponse(raw: unknown): void {
    const parsed = parseControlResponsePayload(raw);
    if (parsed.ok === false) {
      this.host.notifyWarning(
        `ignored a malformed control response: ${parsed.message}`,
      );
      return;
    }
    // Valid responses are classified and consumed by the Task 4 controller
    // pending-response registry; nothing here leaks them into the mailbox.
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
   * guarded-injection queue, the outbound response queue, and per-sender
   * deduplication records. Failure responses are sent directly (never queued)
   * so nothing outlives the cleanup.
   */
  private cleanupTracking(
    code: "target_reloading" | "target_disconnected",
  ): void {
    // Bump first so late async submission callbacks from earlier sends can
    // never requeue into the cleared queue.
    this.generation += 1;
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
      const interleaved = op.interleaved;
      if (op.abortRequests.length > 0) {
        this.sendResponse(
          op.controller,
          this.buildResponse(
            op.id,
            op.command,
            "failed",
            op.sequence++,
            { interleaved },
            { code, message: boundedCleanupMessage(code) },
          ),
          true,
          false,
        );
        for (const abort of op.abortRequests) {
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
      } else {
        this.sendResponse(
          op.controller,
          this.buildResponse(
            op.id,
            op.command,
            "failed",
            op.sequence++,
            { interleaved },
            { code, message: boundedCleanupMessage(code) },
          ),
          true,
          false,
        );
      }
    }
    this.active = null;
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
