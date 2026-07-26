/**
 * inter-agent-pi
 * Pi extension for connecting to the inter-agent message bus
 *
 * Provides commands and tools to send, broadcast, list sessions, check status,
 * inspect local identity, and receive incoming messages as Pi notifications.
 *
 * Installation:
 * ```bash
 * pi install npm:inter-agent-pi@0.2.0
 * ```
 *
 * Or load directly from the source checkout:
 * ```bash
 * pi -e /path/to/inter-agent-pi/src/index.ts
 * ```
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";

// Test seam: production uses Node's `spawn`; behavior tests inject a fake
// factory to drive listener stdout without a real bus. Keep the default so the
// real runtime is unchanged.
let spawnChildProcess: typeof spawn = spawn;

/** @internal Replace the child process factory for behavior tests. */
export function _setSpawnForTest(impl: typeof spawn | null): void {
  spawnChildProcess = impl ?? spawn;
}

// Test seam: production resolves a process-global one-use carrier; behavior
// tests inject a fake carrier so reload lifecycle cases stay hermetic.
let reloadCarrierOverride: ReloadHandoffCarrier | null = null;
const defaultProcessCarrier = createProcessGlobalHandoffCarrier();

function resolveReloadCarrier(): ReloadHandoffCarrier {
  return reloadCarrierOverride ?? defaultProcessCarrier;
}

/** @internal Replace the reload handoff carrier for behavior tests. */
export function _setReloadCarrierForTest(
  carrier: ReloadHandoffCarrier | null,
): void {
  reloadCarrierOverride = carrier;
}
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import {
  MAILBOX_MAX_UNREAD,
  MAILBOX_NOTICE_DEBOUNCE_MS_DEFAULT,
  MailboxDispatcher,
  buildNoticeCompact,
  buildNoticeExpanded,
  createProcessGlobalHandoffCarrier,
  deriveInboundMetadata,
  effectiveDeliveryMode,
  effectiveDebounceMs,
  isValidDebounceMs,
  isValidDeliveryMode,
} from "./mailbox.js";
import type {
  InboundImmediateMessage,
  MailboxSnapshot,
  ReloadHandoffCarrier,
} from "./mailbox.js";

// ── Configuration ───────────────────────────────────────────────────────────

interface InterAgentConfig {
  projectPath?: string;
  projectPathExplicit?: boolean;
  host?: string;
  port?: number | string;
  dataDir?: string;
  secret?: string;
  tls?: boolean | string;
  tlsCert?: string;
  tlsKey?: string;
  deliveryMode?: string;
  mailboxNoticeDebounceMs?: number;
}

interface Settings {
  interAgent?: InterAgentConfig;
}

const MANAGED_RUNTIME_VENV = join(
  homedir(),
  ".pi",
  "agent",
  "inter-agent",
  "venv",
);
const RUNTIME_SETUP_DOCS = "README.md";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolvePathOption(path: string | undefined, baseDir: string) {
  if (!path) return path;
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function resolveConfigPaths(
  config: InterAgentConfig,
  settingsPath: string,
): InterAgentConfig {
  const baseDir = dirname(settingsPath);
  return {
    ...config,
    projectPath: resolvePathOption(config.projectPath, baseDir),
    dataDir: resolvePathOption(config.dataDir, baseDir),
    tlsCert: resolvePathOption(config.tlsCert, baseDir),
    tlsKey: resolvePathOption(config.tlsKey, baseDir),
  };
}

function mergeConfig(
  current: InterAgentConfig,
  next: InterAgentConfig,
  settingsPath: string,
): InterAgentConfig {
  const resolved = resolveConfigPaths(next, settingsPath);
  return {
    ...current,
    ...resolved,
    projectPathExplicit:
      Object.prototype.hasOwnProperty.call(next, "projectPath") ||
      current.projectPathExplicit === true,
  };
}

function loadConfig(): InterAgentConfig {
  const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath = join(process.cwd(), ".pi", "settings.json");

  let config: InterAgentConfig = {};

  // Load global settings first
  if (existsSync(globalSettingsPath)) {
    try {
      const parsed: Settings = JSON.parse(
        readFileSync(globalSettingsPath, "utf-8"),
      );
      if (parsed.interAgent) {
        config = mergeConfig(config, parsed.interAgent, globalSettingsPath);
      }
    } catch {
      // Invalid JSON, ignore
    }
  }

  // Project settings override global
  if (existsSync(projectSettingsPath)) {
    try {
      const parsed: Settings = JSON.parse(
        readFileSync(projectSettingsPath, "utf-8"),
      );
      if (parsed.interAgent) {
        config = mergeConfig(config, parsed.interAgent, projectSettingsPath);
      }
    } catch {
      // Invalid JSON, ignore
    }
  }

  return config;
}

interface InterAgentScripts {
  pi: string;
  connect: string;
  server: string;
  unavailableMessage?: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function scriptsFromBinDir(binDir: string): InterAgentScripts {
  return {
    pi: join(binDir, "inter-agent-pi"),
    connect: join(binDir, "inter-agent-connect"),
    server: join(binDir, "inter-agent-server"),
  };
}

function scriptsAvailable(scripts: InterAgentScripts): boolean {
  return (
    isExecutable(scripts.pi) &&
    isExecutable(scripts.connect) &&
    isExecutable(scripts.server)
  );
}

function findPathCommand(command: string): string | null {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function pathScripts(): InterAgentScripts | null {
  const pi = findPathCommand("inter-agent-pi");
  const connect = findPathCommand("inter-agent-connect");
  const server = findPathCommand("inter-agent-server");
  if (!pi || !connect || !server) return null;
  return { pi, connect, server };
}

function missingConfiguredRuntimeMessage(path: string): string {
  return `inter-agent runtime was not found at ${path}. See ${RUNTIME_SETUP_DOCS}`;
}

function setupNeededMessage(): string {
  return `inter-agent setup needed. See ${RUNTIME_SETUP_DOCS}`;
}

function getScripts(config: InterAgentConfig): InterAgentScripts {
  const helper = process.env.INTER_AGENT_PI_HELPER;
  if (helper) {
    const expanded = expandHome(helper);
    const scripts = scriptsFromBinDir(dirname(expanded));
    if (!scriptsAvailable(scripts) || expanded !== scripts.pi) {
      return {
        ...scripts,
        unavailableMessage: `inter-agent helper override is invalid at ${expanded}. See ${RUNTIME_SETUP_DOCS}`,
      };
    }
    return scripts;
  }

  if (config.projectPathExplicit && config.projectPath) {
    const binDir = join(config.projectPath, ".venv", "bin");
    const scripts = scriptsFromBinDir(binDir);
    if (!scriptsAvailable(scripts)) {
      return {
        ...scripts,
        unavailableMessage: missingConfiguredRuntimeMessage(binDir),
      };
    }
    return scripts;
  }

  const managedScripts = scriptsFromBinDir(join(MANAGED_RUNTIME_VENV, "bin"));
  if (scriptsAvailable(managedScripts)) return managedScripts;

  const fromPath = pathScripts();
  if (fromPath) return fromPath;

  return { ...managedScripts, unavailableMessage: setupNeededMessage() };
}

function interAgentEnv(
  config: InterAgentConfig = loadConfig(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  if (config.host) env.INTER_AGENT_HOST = String(config.host);
  if (config.port !== undefined && config.port !== null) {
    env.INTER_AGENT_PORT = String(config.port);
  }
  if (config.dataDir) env.INTER_AGENT_DATA_DIR = config.dataDir;
  if (config.secret !== undefined)
    env.INTER_AGENT_SECRET = String(config.secret);
  if (config.tls !== undefined) env.INTER_AGENT_TLS = String(config.tls);
  if (config.tlsCert) env.INTER_AGENT_TLS_CERT = config.tlsCert;
  if (config.tlsKey) env.INTER_AGENT_TLS_KEY = config.tlsKey;
  return env;
}

// ── Constants ───────────────────────────────────────────────────────────────

const NOTIFY_MAX_LEN = 1000;
const DEFAULT_NAME = "pi";
const AUTO_STARTED_SERVER_IDLE_TIMEOUT_S = 300;
const SERVER_START_WAIT_ATTEMPTS = 30;
const SERVER_START_WAIT_MS = 500;
const LISTENER_STOP_SIGTERM_TIMEOUT_MS = 2000;
const LISTENER_STOP_SIGKILL_TIMEOUT_MS = 2000;
// Test seam: behavior tests shorten the kill races so a hung-child failing stop
// exercise stays bounded; production keeps the real millisecond timeouts.
let stopTermTimeoutMs = LISTENER_STOP_SIGTERM_TIMEOUT_MS;
let stopKillTimeoutMs = LISTENER_STOP_SIGKILL_TIMEOUT_MS;

/** @internal Shorten the listener stop kill races for behavior tests. */
export function _setStopTimeoutsForTest(
  termMs: number | null,
  killMs: number | null,
): void {
  stopTermTimeoutMs = termMs ?? LISTENER_STOP_SIGTERM_TIMEOUT_MS;
  stopKillTimeoutMs = killMs ?? LISTENER_STOP_SIGKILL_TIMEOUT_MS;
}
// ── State ───────────────────────────────────────────────────────────────────

interface ConnectionState {
  name: string;
  label: string | null;
  connected: boolean;
}

interface ScriptResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface ListenerOptions {
  notifyOnReady?: boolean;
}

let listenerProc: ChildProcess | null = null;
let currentCtx: ExtensionContext | null = null;
let messageBuffer = "";
let listenerReady = false;
let currentConnection: ConnectionState | null = null;
let activeStop: Promise<boolean> | null = null;
let mailboxController: MailboxDispatcher | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + " …";
}

interface ListSession {
  name: string;
  label?: string | null;
}

function isListSession(value: unknown): value is ListSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string") return false;
  return (
    entry.label === undefined ||
    entry.label === null ||
    typeof entry.label === "string"
  );
}

function parseListSessions(value: unknown): ListSession[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid response");
  }
  const payload = value as Record<string, unknown>;
  if (payload.op !== "list_ok") {
    throw new Error("invalid response");
  }
  const sessions = payload.sessions;
  if (!Array.isArray(sessions) || !sessions.every(isListSession)) {
    throw new Error("invalid response");
  }
  return sessions as ListSession[];
}

// Compact one-line summary for the collapsed message renderer.
function messageSummary(details: {
  from?: string;
  text?: string;
  toInfo?: string;
  outgoing?: boolean;
}): string | null {
  const text = details.text ?? "";
  const chars = text.length;
  if (details.outgoing) {
    const toInfo = details.toInfo ?? "";
    if (toInfo.startsWith("to ")) {
      return `sent to ${toInfo.slice(3)} • ${chars} chars`;
    }
    if (toInfo === "broadcast") {
      return `broadcast • ${chars} chars`;
    }
    if (toInfo.startsWith("on ")) {
      return `published on ${toInfo.slice(3)} • ${chars} chars`;
    }
    return `sent ${toInfo} • ${chars} chars`;
  }
  if (details.from) {
    return `from ${details.from} • ${chars} chars`;
  }
  return null;
}

function getConnectionState(ctx: ExtensionContext): ConnectionState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === "inter-agent-state") {
      return entry.data as ConnectionState;
    }
  }
  return null;
}

function persistState(pi: ExtensionAPI, state: ConnectionState) {
  pi.appendEntry("inter-agent-state", state);
}

function notify(
  title: string,
  body: string,
  type: "info" | "warning" | "error" = "info",
) {
  currentCtx?.ui.notify(truncate(`${title}: ${body}`, NOTIFY_MAX_LEN), type);
}

// Build an inbound peer body as a custom `inter-agent-message` payload. The
// content carries the body plus bounded reply-decision guidance; the display
// content is the clean body shown in the TUI. Immediate delivery reuses this
// builder so direct/broadcast/channel formatting and guidance stay identical.
function buildInboundMessage(
  from: string,
  text: string,
  toInfo: string,
): InboundImmediateMessage {
  const noReplyGuidance =
    "If no peer reply or user-facing action is needed, do not send a courtesy reply or discuss the message solely to acknowledge it.";
  const isChannel = toInfo.startsWith("on ");
  let replyInstruction: string;
  if (toInfo === "via broadcast") {
    replyInstruction = `Peer broadcast. Reply directly to ${from} only with inter_agent_send if it advances work or coordination, or to satisfy a request from the user; do not broadcast unless the user asks. ${noReplyGuidance}`;
  } else if (isChannel) {
    replyInstruction = `Peer channel message ${toInfo}. Reply to ${from} only with inter_agent_send, and only if it advances work or coordination; there is no publish tool, so reply directly rather than reposting to the channel. ${noReplyGuidance}`;
  } else {
    replyInstruction = `Peer message. Reply to ${from} only with inter_agent_send, and only if it advances work or coordination. ${noReplyGuidance}`;
  }
  const content = `[inter-agent message from agent ${from} ${toInfo}]

${text}

${replyInstruction}`;
  const displayContent = `[inter-agent message from agent ${from} ${toInfo}]

${text}`;
  return {
    customType: "inter-agent-message",
    content,
    display: true,
    details: { from, text, toInfo, displayContent },
  };
}

function showOutgoingInContext(
  pi: ExtensionAPI,
  from: string,
  text: string,
  toInfo: string,
) {
  pi.sendMessage(
    {
      customType: "inter-agent-message",
      content: `Outbound inter-agent history for a message sent as ${from} ${toInfo}. This records an action already completed; treat it as context, not a new request.

## BEGIN MESSAGE TRANSCRIPT

${text}

## END MESSAGE TRANSCRIPT`,
      display: true,
      details: {
        from,
        text,
        toInfo,
        outgoing: true,
        displayContent: `[outbound inter-agent history — sent by current agent (${from}) ${toInfo}]

${text}`,
      },
    },
    { triggerTurn: false, deliverAs: "followUp" },
  );
}

function execScript(script: string, args: string[]): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const env = interAgentEnv();
    const proc = spawnChildProcess(script, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
    proc.on("error", (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        stderr += `inter-agent command was not found at ${script}. Check that inter-agent is installed and configured, then try again.`;
      } else {
        stderr += String(err);
      }
      resolve({ stdout, stderr, code: null });
    });
  });
}

function execPiScript(
  scripts: InterAgentScripts,
  args: string[],
): Promise<ScriptResult> {
  if (scripts.unavailableMessage) {
    return Promise.resolve({
      stdout: "",
      stderr: scripts.unavailableMessage,
      code: 127,
    });
  }
  return execScript(scripts.pi, args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptFailureMessage(result: ScriptResult, operation: string): string {
  const output = (result.stderr || result.stdout).trim();
  if (!output && result.code === null) {
    return "inter-agent command was not found. Check that inter-agent is installed and configured, then try again.";
  }
  if (output.includes("not found")) {
    return output;
  }
  return truncate(output || `inter-agent ${operation} command failed`, 200);
}

async function readServerStatus(
  scripts: InterAgentScripts,
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string }
> {
  const result = await execPiScript(scripts, ["status", "--json"]);
  if (result.code !== 0) {
    return { ok: false, message: scriptFailureMessage(result, "status") };
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, payload: parsed as Record<string, unknown> };
    }
  } catch {
    // Fall through to the user-facing error below.
  }

  return {
    ok: false,
    message:
      "inter-agent status returned an invalid response. Try /inter-agent status; if this continues, check the inter-agent installation.",
  };
}

function statusState(payload: Record<string, unknown>): string {
  return typeof payload.state === "string" ? payload.state : "unknown";
}

function statusMessage(payload: Record<string, unknown>): string {
  return typeof payload.message === "string"
    ? payload.message
    : statusState(payload);
}

function shouldAutoStartServer(payload: Record<string, unknown>): boolean {
  return statusState(payload) === "unavailable";
}

function statusFailureGuidance(payload: Record<string, unknown>): string {
  const message = statusMessage(payload);
  switch (statusState(payload)) {
    case "auth_failed":
      return `${message}. Check that server and clients use the same inter-agent secret.`;
    case "protocol_mismatch":
      return `${message}. Another process may be using the inter-agent port; try /inter-agent status or restart the server.`;
    case "unavailable":
      return `${message}. Try /inter-agent status, or start inter-agent-server manually.`;
    default:
      return message;
  }
}

function startServerProcess(
  scripts: InterAgentScripts,
): Promise<{ ok: true; pid?: number } | { ok: false; message: string }> {
  if (scripts.unavailableMessage) {
    return Promise.resolve({ ok: false, message: scripts.unavailableMessage });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result: { ok: true; pid?: number } | { ok: false; message: string },
    ) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const proc = spawnChildProcess(
      scripts.server,
      ["--idle-timeout", String(AUTO_STARTED_SERVER_IDLE_TIMEOUT_S)],
      {
        stdio: "ignore",
        shell: false,
        detached: true,
        env: interAgentEnv(loadConfig()),
      },
    );

    proc.once("spawn", () => {
      proc.unref();
      finish({ ok: true, pid: proc.pid });
    });

    proc.once("error", (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        finish({
          ok: false,
          message: `inter-agent server command was not found at ${scripts.server}. Check that inter-agent is installed and configured, then try again.`,
        });
      } else {
        finish({
          ok: false,
          message: `could not start inter-agent server: ${String(err)}`,
        });
      }
    });

    proc.once("exit", (code, signal) => {
      finish({
        ok: false,
        message: `inter-agent server exited before it was ready (code ${code ?? "none"}, signal ${signal ?? "none"}). Try /inter-agent status or start inter-agent-server manually.`,
      });
    });
  });
}

async function waitForServerAvailable(
  scripts: InterAgentScripts,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let lastMessage = "server unavailable";
  for (let i = 0; i < SERVER_START_WAIT_ATTEMPTS; i++) {
    const status = await readServerStatus(scripts);
    if (status.ok === false) {
      lastMessage = status.message;
    } else if (statusState(status.payload) === "available") {
      return { ok: true };
    } else {
      lastMessage = statusFailureGuidance(status.payload);
    }
    await sleep(SERVER_START_WAIT_MS);
  }

  return {
    ok: false,
    message: `Started the inter-agent server, but it did not become available. ${lastMessage}`,
  };
}

async function ensureServerAvailable(
  scripts: InterAgentScripts,
): Promise<boolean> {
  const initial = await readServerStatus(scripts);
  if (initial.ok === false) {
    notify("[inter-agent] connect failed", initial.message, "error");
    return false;
  }

  if (statusState(initial.payload) === "available") {
    notify("[inter-agent] server detected", "connecting now");
    return true;
  }

  if (!shouldAutoStartServer(initial.payload)) {
    notify(
      "[inter-agent] connect failed",
      statusFailureGuidance(initial.payload),
      "error",
    );
    return false;
  }

  notify("[inter-agent] server not detected", "starting now");
  const started = await startServerProcess(scripts);
  if (started.ok === false) {
    notify("[inter-agent] connect failed", started.message, "error");
    return false;
  }

  const ready = await waitForServerAvailable(scripts);
  if (ready.ok === false) {
    notify("[inter-agent] connect failed", ready.message, "error");
    return false;
  }

  notify("[inter-agent] server ready", "connecting now");
  return true;
}

function splitCommandArgs(input: string): string[] {
  const matches = input.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) || [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    }
    return part;
  });
}

function parseConnectArgs(
  args: string,
):
  | { ok: true; name: string; label: string | null }
  | { ok: false; message: string } {
  const parts = splitCommandArgs(args.trim());
  let name = DEFAULT_NAME;
  let label: string | null = null;
  let index = 0;

  if (parts[0] && parts[0] !== "--label") {
    name = parts[0];
    index = 1;
  }

  while (index < parts.length) {
    const part = parts[index];
    if (part === "--label") {
      const value = parts[index + 1];
      if (!value) {
        return {
          ok: false,
          message: "usage: /inter-agent connect <name> [--label <label>]",
        };
      }
      label = value;
      index += 2;
      continue;
    }
    if (label === null) {
      label = part;
      index += 1;
      continue;
    }
    return {
      ok: false,
      message: "usage: /inter-agent connect <name> [--label <label>]",
    };
  }

  return { ok: true, name, label };
}

function parseRenameArgs(
  args: string,
):
  | { ok: true; name: string; label: string | null }
  | { ok: false; message: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: "usage: /inter-agent rename <name> [--label <label>]",
    };
  }
  const parsed = parseConnectArgs(trimmed);
  if (parsed.ok === false) return parsed;
  if (parsed.name === DEFAULT_NAME && trimmed.startsWith("--label")) {
    return {
      ok: false,
      message: "usage: /inter-agent rename <name> [--label <label>]",
    };
  }
  return parsed;
}

function formatConnectError(code: string, text: string): string {
  switch (code) {
    case "NAME_TAKEN":
      return `${code}: ${text}. Choose a different name, or disconnect the existing session and try again.`;
    case "BAD_NAME":
      return `${code}: ${text}. Use lowercase letters, numbers, and hyphens; start with a letter or number; max 40 characters.`;
    case "AUTH_FAILED":
      return `${code}: ${text}. Check that server and clients use the same inter-agent secret.`;
    case "TOO_MANY_CONNECTIONS":
      return `${code}: ${text}. Disconnect another session, then try again.`;
    default:
      return `${code}: ${text}`;
  }
}

// ── Listener Management ─────────────────────────────────────────────────────

async function startListener(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: InterAgentConfig,
  name: string,
  label: string | null,
  options: ListenerOptions = {},
): Promise<boolean> {
  const stopped = await stopListener(pi, ctx, { expected: true });
  if (!stopped) {
    notify(
      "[inter-agent] listener error",
      "previous listener did not terminate; cannot start a new listener",
      "error",
    );
    return false;
  }

  const scripts = getScripts(config);
  if (scripts.unavailableMessage) {
    notify("[inter-agent] listener error", scripts.unavailableMessage, "error");
    return false;
  }
  const args = ["connect", name];
  if (label) args.push("--label", label);

  const proc = spawnChildProcess(scripts.pi, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: interAgentEnv(config),
  });

  listenerProc = proc;
  messageBuffer = "";
  listenerReady = false;
  currentConnection = null;

  proc.stdout?.on("data", (data: Buffer) => {
    // Ignore output from a child that is no longer the current listener or is
    // being explicitly stopped, so stale frames cannot reanimate readiness,
    // overwrite a replacement listener's state, or deliver stale messages.
    if (listenerProc !== proc) return;
    const expected =
      (proc as ChildProcess & { __expectedStop?: boolean }).__expectedStop ===
      true;
    if (expected) return;

    messageBuffer += data.toString();
    const lines = messageBuffer.split("\n");
    messageBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.op === "welcome") {
          const state: ConnectionState = { name, label, connected: true };
          listenerReady = true;
          currentConnection = state;
          persistState(pi, state);
          updateStatus(ctx, state);
          if (options.notifyOnReady) {
            notify(
              "[inter-agent] connected",
              `as ${name}${label ? ` (${label})` : ""}`,
            );
          }
          continue;
        }
        if (msg.op === "error") {
          const code = String(msg.code || "unknown");
          const text = String(msg.message || "connection rejected");
          notify(
            `[inter-agent] connect failed`,
            formatConnectError(code, text),
            "error",
          );
          listenerReady = false;
          currentConnection = null;
          void stopListener(pi, ctx, { expected: true });
          const state = getConnectionState(ctx);
          if (state) {
            persistState(pi, { ...state, connected: false });
            updateStatus(ctx, { ...state, connected: false });
          }
          continue;
        }
        if (msg.op === "msg") {
          // Use the shared inbound parser so kind/toInfo derivation and the
          // `[from: name]` prefix handling stay consistent with the mailbox.
          // A malformed frame continues the per-line loop so a later valid
          // frame in the same stdout chunk is still handled.
          const meta = deriveInboundMetadata(msg);
          if (!meta) {
            notify(
              "[inter-agent] mailbox",
              "dropped an inbound message without a valid msg_id",
              "warning",
            );
            continue;
          }
          const mode = mailboxController?.getDeliveryMode() ?? "queued";
          // Queued notifications are metadata only; immediate mode restores the
          // existing bounded body notification (truncated inside `notify`).
          notify(
            `[inter-agent] ${meta.sender} ${meta.toInfo}`,
            mode === "immediate" ? meta.body : "queued in mailbox",
          );
          mailboxController?.deliverInbound({
            msgId: meta.msgId,
            sender: meta.sender,
            body: meta.body,
            kind: meta.kind,
            channel: meta.channel,
            target: meta.target,
            immediateMessage:
              mode === "immediate"
                ? buildInboundMessage(meta.sender, meta.body, meta.toInfo)
                : undefined,
          });
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    if (listenerProc !== proc) return;
    const expected =
      (proc as ChildProcess & { __expectedStop?: boolean }).__expectedStop ===
      true;
    if (expected) return;

    const text = data.toString().trim();
    if (text) {
      notify("[inter-agent] listener stderr", text, "warning");
    }
  });

  proc.on("exit", (code) => {
    if (listenerProc !== proc) return;
    const expected =
      (proc as ChildProcess & { __expectedStop?: boolean }).__expectedStop ===
      true;
    const state = getConnectionState(ctx);
    const previousName = currentConnection?.name || state?.name || name;
    const wasConnected =
      listenerReady || currentConnection !== null || state?.connected === true;
    listenerProc = null;
    listenerReady = false;
    currentConnection = null;
    if (expected) return;
    // An unexpected exit clears durable routing state so the session_start
    // branch will not treat a dead listener as still connected. Expected
    // stops (disconnect or reload) own the durable-state transition themselves
    // via stopListener, so the exit handler must not overwrite it.
    if (state) {
      persistState(pi, { ...state, connected: false });
      updateStatus(ctx, { ...state, connected: false });
    }
    if (code !== 0 && code !== null) {
      const reconnectHint = wasConnected
        ? `. Use /inter-agent connect ${previousName} to reconnect.`
        : "";
      notify(
        "[inter-agent] listener exited",
        `code ${code}${reconnectHint}`,
        "warning",
      );
    } else if (wasConnected) {
      notify(
        "[inter-agent] disconnected",
        `server connection closed. Use '/inter-agent connect ${previousName}' to reconnect.`,
        "warning",
      );
    }
  });

  proc.on("error", (err) => {
    if (listenerProc !== proc) return;
    const expected =
      (proc as ChildProcess & { __expectedStop?: boolean }).__expectedStop ===
      true;
    if (expected) return;

    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      notify(
        "[inter-agent] listener error",
        "inter-agent connect command was not found. Check that inter-agent is installed and configured, then try again.",
        "error",
      );
    } else {
      notify("[inter-agent] listener error", String(err), "error");
    }
  });

  return true;
}

async function stopListener(
  pi?: ExtensionAPI,
  ctx?: ExtensionContext,
  options: {
    expected?: boolean;
    /** Preserve the durable connected routing state in the transcript (used by
     a same-process `/reload` so the matching `session_start` reconnects the
     same identity once). Explicit disconnect and other shutdowns stay cleared. */
    preserveDurableConnected?: boolean;
  } = {},
): Promise<boolean> {
  const proc = listenerProc;
  const persistAfter = (): void => {
    if (!ctx || !pi) return;
    const state = getConnectionState(ctx);
    if (!state) return;
    const connected =
      options.preserveDurableConnected === true ? state.connected : false;
    persistState(pi, { ...state, connected });
    updateStatus(ctx, { ...state, connected });
  };
  if (!proc) {
    listenerReady = false;
    currentConnection = null;
    messageBuffer = "";
    persistAfter();
    return true;
  }

  if (activeStop) {
    return await activeStop;
  }

  const expected = options.expected === true;
  (proc as ChildProcess & { __expectedStop?: boolean }).__expectedStop =
    expected;

  activeStop = (async (): Promise<boolean> => {
    // Mark in-memory listener state unavailable immediately so no command
    // can use the terminating listener.
    listenerReady = false;
    currentConnection = null;
    messageBuffer = "";

    if (proc.exitCode !== null || proc.signalCode !== null) {
      listenerProc = null;
      return true;
    }

    proc.kill("SIGTERM");

    const termPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        proc.off("exit", onExit);
        proc.off("close", onClose);
      };
      proc.once("exit", onExit);
      proc.once("close", onClose);
      if (proc.exitCode !== null || proc.signalCode !== null) {
        cleanup();
        resolve();
      }
    });

    await Promise.race([termPromise, sleep(stopTermTimeoutMs)]);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      listenerProc = null;
      return true;
    }

    proc.kill("SIGKILL");

    const killPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        proc.off("exit", onExit);
        proc.off("close", onClose);
      };
      proc.once("exit", onExit);
      proc.once("close", onClose);
      if (proc.exitCode !== null || proc.signalCode !== null) {
        cleanup();
        resolve();
      }
    });

    await Promise.race([killPromise, sleep(stopKillTimeoutMs)]);

    if (proc.exitCode !== null || proc.signalCode !== null) {
      listenerProc = null;
      return true;
    }
    return false;
  })();

  try {
    const exited = await activeStop;
    if (exited) {
      persistAfter();
    }
    return exited;
  } finally {
    activeStop = null;
  }
}

function updateStatus(ctx: ExtensionContext, state: ConnectionState | null) {
  if (state?.connected) {
    ctx.ui.setStatus("inter-agent", `Inter-agent: ${state.name} 🌐 `);
  } else {
    ctx.ui.setStatus("inter-agent", undefined);
  }
}

// ── Extension Export ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const currentScripts = () => getScripts(config);

  // ── Mailbox state and delivery ───────────────────────────────
  const initialMode = effectiveDeliveryMode(config.deliveryMode);
  const initialDebounce = effectiveDebounceMs(config.mailboxNoticeDebounceMs);
  const modeConfiguredInvalid =
    config.deliveryMode !== undefined &&
    !isValidDeliveryMode(config.deliveryMode);
  const debounceConfiguredInvalid =
    config.mailboxNoticeDebounceMs !== undefined &&
    !isValidDebounceMs(config.mailboxNoticeDebounceMs);
  let warnedInvalidMode = false;
  let warnedInvalidDebounce = false;

  const mailbox = new MailboxDispatcher(
    {
      isIdle: () => currentCtx?.isIdle() ?? true,
      hasPendingMessages: () => currentCtx?.hasPendingMessages() ?? false,
      sendNotice: (message, triggerTurn) =>
        pi.sendMessage(message, { triggerTurn, deliverAs: "followUp" }),
      sendImmediate: (message, triggerTurn) =>
        pi.sendMessage(message, { triggerTurn, deliverAs: "followUp" }),
      notifyWarning: (body) => notify("[inter-agent] mailbox", body, "warning"),
      schedule: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
    },
    initialMode,
    initialDebounce,
  );
  mailboxController = mailbox;

  // ── Custom message renderer ──────────────────────────────────────────────
  // Show a clean, user-facing summary in the TUI (from details.displayContent)
  // while the full `content` (with internal agent instructions) goes to the LLM.
  pi.registerMessageRenderer<{
    displayContent?: string;
    from?: string;
    text?: string;
    toInfo?: string;
    outgoing?: boolean;
  }>("inter-agent-message", (message, { expanded }, theme) => {
    const details =
      typeof message.details === "object" &&
      message.details !== null &&
      "displayContent" in message.details
        ? (message.details as {
            displayContent?: string;
            from?: string;
            text?: string;
            toInfo?: string;
            outgoing?: boolean;
          })
        : undefined;
    const display =
      details?.displayContent ??
      (typeof message.content === "string" ? message.content : "");
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(
      new Text(
        theme.fg("customMessageLabel", `\x1b[1m[inter-agent-message]\x1b[22m`),
        0,
        0,
      ),
    );
    box.addChild(new Spacer(1));
    if (expanded) {
      box.addChild(new Text(theme.fg("customMessageText", display), 0, 0));
    } else {
      const summary = details ? messageSummary(details) : null;
      if (summary) {
        box.addChild(new Text(theme.fg("muted", summary), 0, 0));
      }
    }
    return box as unknown as Component;
  });

  // Metadata-only mailbox notice renderer. Compact rendering shows unread
  // counts grouped by sender; expanded rendering lists every unread ID, sender,
  // kind, and channel. Details never contain bodies.
  pi.registerMessageRenderer<MailboxSnapshot>(
    "inter-agent-mailbox",
    (message, { expanded }, theme) => {
      const snap =
        typeof message.details === "object" && message.details !== null
          ? (message.details as MailboxSnapshot)
          : { unread: 0, messages: [], bySender: [] };
      const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(
        new Text(
          theme.fg(
            "customMessageLabel",
            `\x1b[1m[inter-agent-mailbox]\x1b[22m`,
          ),
          0,
          0,
        ),
      );
      box.addChild(new Spacer(1));
      if (expanded) {
        box.addChild(
          new Text(
            theme.fg("customMessageText", buildNoticeExpanded(snap).join("\n")),
            0,
            0,
          ),
        );
      } else {
        box.addChild(
          new Text(theme.fg("muted", buildNoticeCompact(snap)), 0, 0),
        );
      }
      return box as unknown as Component;
    },
  );

  // Register the startup routing-name flag during extension factory so Pi
  // exposes `pi --inter-agent <name>`. The value is only available later, at
  // `session_start`.
  pi.registerFlag("inter-agent", {
    type: "string",
    description:
      "Set this Pi worker's inter-agent routing name at process startup",
  });

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;

    // Same-process `/reload` preserves the bounded unread mailbox through the
    // one-use carrier; every other start reason starts empty and clears any
    // stale handoff. Restoration is metadata/bodies only and never starts a
    // second listener or changes routing identity.
    if (event?.reason === "reload") {
      mailbox.restoreReloadHandoff(
        ctx.sessionManager.getSessionId(),
        resolveReloadCarrier(),
      );
      // Flush a restored pending body-free notice once, now that the new
      // runtime is idle; settle is a no-op unless a notice is actually pending.
      mailbox.settle();
    } else {
      resolveReloadCarrier().reset();
    }

    // Warn exactly once per invalid configured key once UI context exists.
    if (modeConfiguredInvalid && !warnedInvalidMode) {
      warnedInvalidMode = true;
      notify(
        "[inter-agent] config",
        `interAgent.deliveryMode ${JSON.stringify(config.deliveryMode)} is invalid; using "queued"`,
        "warning",
      );
    }
    if (debounceConfiguredInvalid && !warnedInvalidDebounce) {
      warnedInvalidDebounce = true;
      notify(
        "[inter-agent] config",
        `interAgent.mailboxNoticeDebounceMs is invalid; using ${MAILBOX_NOTICE_DEBOUNCE_MS_DEFAULT} ms`,
        "warning",
      );
    }
    // Prefer an explicit --inter-agent flag over any transcript-restored
    // connection state. The flag is reapplied on every session_start reason
    // (startup, reload, new, resume, fork) so the worker identity stays
    // effective after Pi replaces or reloads the extension session.
    const flagValue = pi.getFlag("inter-agent");
    const flagPresent = typeof flagValue === "string";

    if (flagPresent) {
      const explicitName = flagValue.trim();
      if (!explicitName) {
        notify(
          "[inter-agent] connect failed",
          "inter-agent routing name cannot be blank; use --inter-agent <name> or omit the flag",
          "error",
        );
        return;
      }

      const ready = await ensureServerAvailable(currentScripts());
      if (!ready) {
        const state = getConnectionState(ctx);
        if (state) {
          persistState(pi, { ...state, connected: false });
          updateStatus(ctx, { ...state, connected: false });
        }
        return;
      }
      const started = await startListener(pi, ctx, config, explicitName, null, {
        notifyOnReady: true,
      });
      if (started) {
        notify("[inter-agent] connecting", `as ${explicitName}`);
      }
      return;
    }

    const state = getConnectionState(ctx);
    if (state?.connected) {
      const ready = await ensureServerAvailable(currentScripts());
      if (!ready) {
        persistState(pi, { ...state, connected: false });
        updateStatus(ctx, { ...state, connected: false });
        return;
      }
      const started = await startListener(
        pi,
        ctx,
        config,
        state.name,
        state.label,
        {
          notifyOnReady: true,
        },
      );
      if (started) {
        notify("[inter-agent] reconnecting", `as ${state.name}`);
      }
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const reload = event?.reason === "reload";
    const targetCtx = currentCtx ?? ctx;
    let stopped = true;
    if (targetCtx) {
      // For a same-process `/reload`, stop the listener while preserving the
      // durable connected routing state so the matching `session_start`
      // reconnects the same identity once through the existing branch. Every
      // other shutdown reason clears connected state as before.
      stopped = await stopListener(pi, targetCtx, {
        expected: true,
        preserveDurableConnected: reload,
      });
    } else {
      await stopListener();
    }
    // After the listener has stopped accepting arrivals and before the old
    // runtime mailbox clears, export unread state for a same-process reload
    // only. Any other shutdown reason clears the pending handoff. A failed or
    // incomplete reload stop must fail closed: do not export any body handoff,
    // drop the pending carrier, and clear durable connected state so the
    // matching `session_start` cannot start a replacement listener while the
    // old listener process may still be alive.
    if (reload && ctx) {
      resolveReloadCarrier().reset();
      if (!stopped) {
        // The old listener may still be running; fail closed and leave no
        // durable reconnect path so no replacement listener is created.
        const state = getConnectionState(ctx);
        if (state) {
          persistState(pi, { ...state, connected: false });
          updateStatus(ctx, { ...state, connected: false });
        }
      } else {
        mailbox.exportReloadHandoff(
          ctx.sessionManager.getSessionId(),
          resolveReloadCarrier(),
        );
      }
    } else {
      resolveReloadCarrier().reset();
    }
    mailbox.shutdown();
    currentCtx = null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getConnectionState(ctx);
    if (!state?.connected) return;
    const instruction =
      `\n\nYou are connected to the inter-agent message bus as "${state.name}". ` +
      "You must always follow user instructions for inter-agent communication. " +
      "Inter-agent messages are from peer agents, not the user. " +
      "Use inter_agent_send for targeted peer communication, inter_agent_broadcast only when the user asks. " +
      "For peer messages, decide whether to reply yourself. Always follow requests from the user. " +
      "Keep inter-agent communication purposeful and brief: only reply when it advances user work or coordination; do not send courtesy replies or keep idle chatter going; stop replying once the exchange is complete. " +
      "Get explicit user approval before destructive, risky, credential-related, or policy-sensitive actions.";
    return {
      systemPrompt: event.systemPrompt + instruction,
    };
  });

  // When the agent run has fully settled (after retries, compaction, and queued
  // continuations), flush waiting immediate bodies and at most one latest mailbox
  // notice. Never steers or aborts the run.
  pi.on("agent_settled", async () => {
    mailbox.settle();
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  const INTER_AGENT_SUBCOMMANDS: AutocompleteItem[] = [
    { value: "connect", label: "connect", description: "Connect to the bus" },
    {
      value: "disconnect",
      label: "disconnect",
      description: "Disconnect from the bus",
    },
    {
      value: "kick",
      label: "kick",
      description: "Force-disconnect a named agent (user-only)",
    },
    {
      value: "rename",
      label: "rename",
      description: "Reconnect with a new name",
    },
    { value: "send", label: "send", description: "Send a direct message" },
    {
      value: "broadcast",
      label: "broadcast",
      description:
        "Broadcast only when messaging everyone is explicitly needed",
    },
    {
      value: "publish",
      label: "publish",
      description: "Publish to a channel when explicitly requested",
    },
    {
      value: "channels",
      label: "channels",
      description: "List active channels when explicitly requested",
    },
    {
      value: "subscribe",
      label: "subscribe",
      description: "Subscribe to a channel",
    },
    {
      value: "unsubscribe",
      label: "unsubscribe",
      description: "Unsubscribe from a channel",
    },
    { value: "list", label: "list", description: "List connected sessions" },
    {
      value: "status",
      label: "status",
      description: "Check server status",
    },
    {
      value: "delivery",
      label: "delivery",
      description:
        "Set [i]mmediate or [q]ueued (via mailbox) message delivery <immediate|queued>",
    },
  ];

  async function handleConnect(args: string, ctx: ExtensionContext) {
    const parsed = parseConnectArgs(args);
    if (parsed.ok === false) {
      notify("[inter-agent] connect failed", parsed.message, "error");
      return;
    }

    const ready = await ensureServerAvailable(currentScripts());
    if (!ready) return;

    const started = await startListener(
      pi,
      ctx,
      config,
      parsed.name,
      parsed.label,
      {
        notifyOnReady: true,
      },
    );
    if (!started) return;

    notify(
      "[inter-agent] connecting",
      `as ${parsed.name}${parsed.label ? ` (${parsed.label})` : ""}`,
    );
  }

  async function handleDisconnect(_args: string, ctx: ExtensionContext) {
    const stopped = await stopListener(pi, ctx, { expected: true });
    if (stopped) {
      notify("[inter-agent] disconnected", "listener stopped");
    } else {
      notify(
        "[inter-agent] disconnect failed",
        "listener did not terminate",
        "error",
      );
    }
  }

  async function handleKick(args: string, _ctx: ExtensionContext) {
    const name = args.trim();
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      notify(
        "[inter-agent] kick failed",
        "usage: /inter-agent kick <name>",
        "error",
      );
      return;
    }
    // Kick is user-only and uses a short-lived authenticated control
    // connection; it does not require this Pi listener to be connected.
    const result = await execPiScript(currentScripts(), ["kick", name]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] kick failed",
        scriptFailureMessage(result, "kick"),
        "error",
      );
      return;
    }
    try {
      const payload = JSON.parse(result.stdout);
      if (payload.op !== "kick_ok") {
        notify("[inter-agent] kick failed", "invalid response", "error");
        return;
      }
      notify(
        "[inter-agent] kicked",
        `removed ${payload.name} (session ${payload.session_id})`,
      );
    } catch {
      notify("[inter-agent] kick failed", "invalid response", "error");
    }
  }

  async function handleRename(args: string, ctx: ExtensionContext) {
    if (!listenerReady || !currentConnection) {
      notify(
        "[inter-agent] rename failed",
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        "error",
      );
      return;
    }
    const parsed = parseRenameArgs(args);
    if (parsed.ok === false) {
      notify("[inter-agent] rename failed", parsed.message, "error");
      return;
    }

    const oldName = currentConnection.name;
    const label = parsed.label ?? currentConnection.label;
    const ready = await ensureServerAvailable(currentScripts());
    if (!ready) return;

    const started = await startListener(pi, ctx, config, parsed.name, label, {
      notifyOnReady: true,
    });
    if (!started) {
      notify(
        "[inter-agent] rename failed",
        "previous listener did not terminate",
        "error",
      );
      return;
    }

    notify(
      "[inter-agent] renaming",
      `${oldName} -> ${parsed.name}${label ? ` (${label})` : ""}`,
    );
  }

  async function handleSend(args: string, _ctx: ExtensionContext) {
    const match = args.trim().match(/^(\S+)\s+(.+)$/s);
    if (!match) {
      notify(
        "[inter-agent] send failed",
        "usage: /inter-agent send <to> <text>",
        "error",
      );
      return;
    }
    const [, to, text] = match;
    if (!listenerReady || !currentConnection) {
      notify(
        "[inter-agent] send failed",
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        "error",
      );
      return;
    }
    const name = currentConnection.name;
    const result = await execPiScript(currentScripts(), [
      "send",
      to,
      text,
      "--from",
      name,
    ]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] send failed",
        scriptFailureMessage(result, "send"),
        "error",
      );
      return;
    }
    notify("[inter-agent] sent", `to ${to}`);
    showOutgoingInContext(pi, name, text, `to ${to}`);
  }

  async function handleBroadcast(args: string, _ctx: ExtensionContext) {
    const text = args.trim();
    if (!text) {
      notify("[inter-agent] broadcast failed", "message required", "error");
      return;
    }
    if (!listenerReady || !currentConnection) {
      notify(
        "[inter-agent] broadcast failed",
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        "error",
      );
      return;
    }
    const name = currentConnection.name;
    const result = await execPiScript(currentScripts(), [
      "broadcast",
      text,
      "--from",
      name,
    ]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] broadcast failed",
        scriptFailureMessage(result, "broadcast"),
        "error",
      );
      return;
    }
    notify("[inter-agent] broadcast", "sent");
    showOutgoingInContext(pi, name, text, "broadcast");
  }

  async function handlePublish(args: string, _ctx: ExtensionContext) {
    const match = args.trim().match(/^(\S+)\s+(.+)$/s);
    if (!match) {
      notify(
        "[inter-agent] publish failed",
        "usage: /inter-agent publish <channel> <text>",
        "error",
      );
      return;
    }
    const [, channel, text] = match;
    if (!listenerReady || !currentConnection) {
      notify(
        "[inter-agent] publish failed",
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        "error",
      );
      return;
    }
    const name = currentConnection.name;
    const result = await execPiScript(currentScripts(), [
      "publish",
      channel,
      text,
      "--from",
      name,
    ]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] publish failed",
        scriptFailureMessage(result, "publish"),
        "error",
      );
      return;
    }
    notify("[inter-agent] published", `on ${channel}`);
    showOutgoingInContext(pi, name, text, `on ${channel}`);
  }

  async function handleChannels(args: string, _ctx: ExtensionContext) {
    if (args.trim()) {
      notify(
        "[inter-agent] channels failed",
        "usage: /inter-agent channels",
        "error",
      );
      return;
    }
    const result = await execPiScript(currentScripts(), ["channels", "--json"]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] channels failed",
        scriptFailureMessage(result, "channels"),
        "error",
      );
      return;
    }
    try {
      const payload: unknown = JSON.parse(result.stdout);
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (payload as { op?: unknown }).op !== "channels_ok" ||
        !Array.isArray((payload as { channels?: unknown }).channels)
      ) {
        throw new Error("invalid response");
      }
      const channels = (payload as { channels: unknown[] }).channels;
      const lines = channels.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("invalid response");
        }
        const name = (entry as { name?: unknown }).name;
        const subscribers = (entry as { subscribers?: unknown }).subscribers;
        if (
          typeof name !== "string" ||
          !Array.isArray(subscribers) ||
          !subscribers.every((subscriber) => typeof subscriber === "string")
        ) {
          throw new Error("invalid response");
        }
        return `${name}: ${subscribers.join(", ")}`;
      });
      notify(
        "[inter-agent] channels",
        lines.join("; ") || "no channels currently have subscribers",
      );
    } catch {
      notify("[inter-agent] channels failed", "invalid response", "error");
    }
  }

  async function handleSubscribe(args: string, _ctx: ExtensionContext) {
    const channel = args.trim();
    const parts = channel.split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      notify(
        "[inter-agent] subscribe failed",
        "usage: /inter-agent subscribe <channel>",
        "error",
      );
      return;
    }
    if (!listenerReady || !currentConnection) {
      notify(
        "[inter-agent] subscribe failed",
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        "error",
      );
      return;
    }
    const name = currentConnection.name;
    const result = await execPiScript(currentScripts(), [
      "subscribe",
      channel,
      "--name",
      name,
    ]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] subscribe failed",
        scriptFailureMessage(result, "subscribe"),
        "error",
      );
      return;
    }
    notify("[inter-agent] subscribed", channel);
  }

  async function handleUnsubscribe(args: string, _ctx: ExtensionContext) {
    const channel = args.trim();
    const parts = channel.split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      notify(
        "[inter-agent] unsubscribe failed",
        "usage: /inter-agent unsubscribe <channel>",
        "error",
      );
      return;
    }
    if (!listenerReady || !currentConnection) {
      notify(
        "[inter-agent] unsubscribe failed",
        "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        "error",
      );
      return;
    }
    const name = currentConnection.name;
    const result = await execPiScript(currentScripts(), [
      "unsubscribe",
      channel,
      "--name",
      name,
    ]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] unsubscribe failed",
        scriptFailureMessage(result, "unsubscribe"),
        "error",
      );
      return;
    }
    notify("[inter-agent] unsubscribed", channel);
  }

  async function handleDelivery(args: string, _ctx: ExtensionContext) {
    const raw = args.trim();
    const first = raw.charAt(0).toLowerCase();
    const mode = first === "i" ? "immediate" : first === "q" ? "queued" : raw;
    if (mode !== "queued" && mode !== "immediate") {
      notify(
        "[inter-agent] delivery failed",
        "usage: /inter-agent delivery <immediate|queued> (aliases: i, q)",
        "error",
      );
      return;
    }
    mailbox.setDeliveryMode(mode);
    notify(
      "[inter-agent] delivery",
      `future arrivals will be delivered ${
        mode === "immediate" ? "immediately" : "into the mailbox queue"
      }; ${mailbox.size} unread message(s) already queued are left unchanged`,
    );
  }

  async function handleList(_args: string, _ctx: ExtensionContext) {
    const result = await execPiScript(currentScripts(), ["list", "--json"]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] list failed",
        scriptFailureMessage(result, "list"),
        "error",
      );
      return;
    }
    try {
      const sessions = parseListSessions(JSON.parse(result.stdout));
      const lines = sessions.map(
        (s) => `• ${s.name}${s.label ? ` (${s.label})` : ""}`,
      );
      if (lines.length === 0) {
        notify("[inter-agent] list", "no agents connected");
      } else {
        notify("[inter-agent] list", lines.join(", "));
      }
    } catch {
      notify("[inter-agent] list failed", "invalid response", "error");
    }
  }

  async function handleStatus(_args: string, _ctx: ExtensionContext) {
    const result = await execPiScript(currentScripts(), ["status", "--json"]);
    if (result.code !== 0) {
      notify(
        "[inter-agent] status failed",
        scriptFailureMessage(result, "status"),
        "error",
      );
      return;
    }
    try {
      const payload = JSON.parse(result.stdout);
      const state = String(payload.state || "unknown");
      const msg = String(payload.message || state);
      notify(
        "[inter-agent] status",
        msg,
        state === "available" ? "info" : "warning",
      );
    } catch {
      notify("[inter-agent] status failed", "invalid response", "error");
    }
  }

  function showInterAgentUsage() {
    notify(
      "[inter-agent] usage",
      "usage: /inter-agent <connect|disconnect|kick|rename|send|broadcast|publish|channels|subscribe|unsubscribe|list|status|delivery> [args]",
      "warning",
    );
  }

  pi.registerCommand("inter-agent", {
    description: "Inter-agent bus commands",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const filtered = INTER_AGENT_SUBCOMMANDS.filter((s) =>
        s.value.startsWith(prefix),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        showInterAgentUsage();
        return;
      }
      const subcommand = trimmed.split(/\s+/, 1)[0];
      const rest = trimmed.slice(subcommand.length).trimStart();
      switch (subcommand) {
        case "connect":
          await handleConnect(rest, ctx);
          break;
        case "disconnect":
          await handleDisconnect(rest, ctx);
          break;
        case "kick":
          await handleKick(rest, ctx);
          break;
        case "rename":
          await handleRename(rest, ctx);
          break;
        case "send":
          await handleSend(rest, ctx);
          break;
        case "broadcast":
          await handleBroadcast(rest, ctx);
          break;
        case "publish":
          await handlePublish(rest, ctx);
          break;
        case "channels":
          await handleChannels(rest, ctx);
          break;
        case "subscribe":
          await handleSubscribe(rest, ctx);
          break;
        case "unsubscribe":
          await handleUnsubscribe(rest, ctx);
          break;
        case "list":
          await handleList(rest, ctx);
          break;
        case "status":
          await handleStatus(rest, ctx);
          break;
        case "delivery":
          await handleDelivery(rest, ctx);
          break;
        default:
          showInterAgentUsage();
      }
    },
  });

  // ── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "inter_agent_send",
    label: "Send inter-agent message",
    description:
      "Send a direct message to another agent on the inter-agent bus",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent routing name" }),
      text: Type.String({ description: "Message text" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { to, text } = params as { to: string; text: string };
      if (!listenerReady || !currentConnection) {
        throw new Error(
          "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        );
      }
      const name = currentConnection.name;
      const result = await execPiScript(currentScripts(), [
        "send",
        to,
        text,
        "--from",
        name,
      ]);
      if (result.code !== 0) {
        throw new Error(scriptFailureMessage(result, "send"));
      }
      showOutgoingInContext(pi, name, text, `to ${to}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent from the current agent to ${to}`,
          },
        ],
        details: { to, text },
      };
    },
  });

  pi.registerTool({
    name: "inter_agent_broadcast",
    label: "Broadcast inter-agent message",
    description:
      "Broadcast to all agents only when the user explicitly asks to message " +
      "everyone; prefer inter_agent_send for replies.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text for all agents" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { text } = params as { text: string };
      if (!listenerReady || !currentConnection) {
        throw new Error(
          "Not connected to the inter-agent bus. Use /inter-agent connect first.",
        );
      }
      const name = currentConnection.name;
      const result = await execPiScript(currentScripts(), [
        "broadcast",
        text,
        "--from",
        name,
      ]);
      if (result.code !== 0) {
        throw new Error(scriptFailureMessage(result, "broadcast"));
      }
      showOutgoingInContext(pi, name, text, "broadcast");
      return {
        content: [
          { type: "text" as const, text: "Broadcast sent to all other agents" },
        ],
        details: { text },
      };
    },
  });

  pi.registerTool({
    name: "inter_agent_list",
    label: "List inter-agent sessions",
    description: "List all connected agent sessions on the inter-agent bus",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const result = await execPiScript(currentScripts(), ["list", "--json"]);
      if (result.code !== 0) {
        throw new Error(`List failed: ${scriptFailureMessage(result, "list")}`);
      }
      try {
        const sessions = parseListSessions(JSON.parse(result.stdout));
        const lines = sessions.map(
          (s) => `• ${s.name}${s.label ? ` (${s.label})` : ""}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n") || "No agents connected",
            },
          ],
          details: { sessions },
        };
      } catch {
        throw new Error("Invalid list response");
      }
    },
  });

  pi.registerTool({
    name: "inter_agent_whoami",
    label: "Inter-agent local identity",
    description:
      "Report this Pi session's local inter-agent connection identity",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getConnectionState(ctx);
      const listenerRunning = listenerProc !== null;
      const connected =
        listenerReady && listenerRunning && currentConnection !== null;
      const name = connected ? currentConnection.name : null;
      const label = connected ? currentConnection.label : null;
      const lines = connected
        ? [
            "Connected: true",
            `Name: ${name}`,
            ...(label ? [`Label: ${label}`] : []),
          ]
        : [
            "Connected: false",
            ...(state?.name ? [`Last name: ${state.name}`] : []),
          ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          connected,
          name,
          label,
          listener_running: listenerRunning,
          saved_name: state?.name ?? null,
          saved_connected: state?.connected ?? false,
        },
      };
    },
  });

  pi.registerTool({
    name: "inter_agent_status",
    label: "Inter-agent server status",
    description: "Check the status of the inter-agent server",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const result = await execPiScript(currentScripts(), ["status", "--json"]);
      if (result.code !== 0) {
        throw new Error(
          `Status check failed: ${scriptFailureMessage(result, "status")}`,
        );
      }
      try {
        const payload = JSON.parse(result.stdout);
        const text = `State: ${payload.state}\nMessage: ${payload.message}\nReachable: ${payload.server_reachable}`;
        return {
          content: [{ type: "text" as const, text }],
          details: payload,
        };
      } catch {
        throw new Error("Invalid status response");
      }
    },
  });

  pi.registerTool({
    name: "inter_agent_read_messages",
    label: "Read queued inter-agent messages",
    description:
      "Read and remove queued inter-agent messages from the Pi mailbox. Only " +
      "messages you have not read yet are returned. Reading never sends, replies, " +
      "subscribes, publishes, or triggers any peer action.",
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          maxItems: MAILBOX_MAX_UNREAD,
          uniqueItems: true,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { ids } = params as { ids?: string[] };
      const result = mailbox.read(ids);
      const readLines = result.read.map((m) => {
        const where = m.channel
          ? ` on ${m.channel}`
          : m.target
            ? ` to ${m.target}`
            : "";
        return `## ${m.msgId}\nfrom ${m.sender}${where} (${m.kind})\n\n${m.body}`;
      });
      let text: string;
      if (result.read.length === 0) {
        text =
          result.missing.length > 0
            ? `0 messages read. Not unread or missing: ${result.missing.join(", ")}`
            : "0 messages read; mailbox is empty";
      } else {
        text = `${result.read.length} message(s) read\n\n${readLines.join(
          "\n\n",
        )}`;
        if (result.missing.length > 0) {
          text += `\n\nNot unread or missing: ${result.missing.join(", ")}`;
        }
      }
      return {
        content: [{ type: "text" as const, text }],
        details: {
          read: result.read.map((m) => ({
            id: m.msgId,
            sender: m.sender,
            kind: m.kind,
            channel: m.channel,
            target: m.target,
            body: m.body,
          })),
          missing: result.missing,
          remaining: result.remaining,
        },
      };
    },
  });
}
