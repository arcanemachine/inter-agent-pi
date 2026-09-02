# Pi Adapter

Pi-facing command UX built on top of the universal core protocol. Pi users should run `inter-agent-pi` commands rather than the lower-level core protocol commands.

The command examples below use `uv run` from a source checkout. For the
released managed installation, invoke the same commands through
`$HOME/.pi/agent/inter-agent/venv/bin/inter-agent-pi` instead. For example:

```bash
"$HOME/.pi/agent/inter-agent/venv/bin/inter-agent-pi" status --json
```

Before a server is running, `status` reports an unavailable state and exits
successfully so scripts can inspect the JSON result. After the listener
connects, it should report an available state.

## Commands

Run Pi adapter commands through the installed package entry point:

- `uv run inter-agent-pi connect <name> [--label <label>]`
- `uv run inter-agent-pi send <to> <text> [--from <name>]`
- `uv run inter-agent-pi broadcast <text> [--from <name>]`
- `uv run inter-agent-pi subscribe <channel> --name <connected-name>`
- `uv run inter-agent-pi unsubscribe <channel> --name <connected-name>`
- `uv run inter-agent-pi publish <channel> <text> [--from <name>]`
- `uv run inter-agent-pi channels [--json]`
- `uv run inter-agent-pi list [--json]`
- `uv run inter-agent-pi status [--json]`
- `uv run inter-agent-pi shutdown`

The Pi extension auto-starts the server when `/inter-agent-connect` runs and no healthy server is available. Auto-started servers use an explicit 300-second idle timeout and shut down after that period with no connected sessions. Manual server starts remain supported with `uv run inter-agent-server` and run until explicit shutdown unless you pass `--idle-timeout <seconds>`.

Use `send` for normal replies and targeted coordination. Use `broadcast` only when the user explicitly asks to message everyone or the information is genuinely for every connected session. Host integrations that send through the short-lived CLI should pass their connected routing name with `--from <name>` so receivers see the real sender instead of the control connection.

## Channels (pub/sub)

`subscribe` and `unsubscribe` select the target listener explicitly with `--name <connected-name>` and operate on that live listener's existing session rather than opening a new one. They are delivered through a private local Unix-domain control socket and print the raw protocol acknowledgment JSON (`subscribe_ok` / `unsubscribe_ok`) on success. Protocol errors print an adapter-prefixed diagnostic to stderr and return a non-zero exit code. A missing, stale, or reconnecting listener fails cleanly without a traceback.

`publish <channel> <text>` publishes to a channel and accepts the optional user-level sender `--from <name>`. Pi publish success prints the welcome envelope, matching `send` and `broadcast`; protocol errors such as `UNKNOWN_CHANNEL` are reported on stderr with a non-zero exit code. Pi does not apply publish-side duplicate suppression.

`channels [--json]` lists channels and their subscribers as the raw `channels_ok` protocol JSON.

Pi listener output remains raw protocol JSON, so a channel delivery is distinguished by its `channel` field and the absence of a `to` field.

Subscriptions are retained across transient listener reconnects: the listener re-applies the desired subscription set after reconnecting and before reporting readiness. Subscriptions are not persisted across an explicit listener stop or process restart; there are no automatic or default subscriptions.

## Example workflow

1. Connect two Pi sessions in separate terminals:
   - `uv run inter-agent-pi connect agent-a --label "Agent A"`
   - `uv run inter-agent-pi connect agent-b --label "Agent B"`

2. Send a direct message to a routing name:
   - `uv run inter-agent-pi send agent-b "run tests"`

3. Broadcast only when every connected session needs the message:
   - `uv run inter-agent-pi broadcast "build is green for everyone"`

4. Inspect sessions and server state:
   - `uv run inter-agent-pi list --json`
   - `uv run inter-agent-pi status --json`

5. Stop the local server:
   - `uv run inter-agent-pi shutdown`

`label` is optional display metadata; routing still uses `name`. Direct targets resolve by exact routing name first, then by unique routing-name prefix. `list` is core-supported and adapter-exposed.

## Output and failures

Pi command output is JSON-oriented. Stdout is reserved for protocol or status payloads that host tooling can parse. Stderr is reserved for local diagnostics such as connection failures. Normal operational failures do not emit Python tracebacks.

`connect`, `send`, `broadcast`, and `list` print core protocol envelopes as JSON lines. `list` returns agent sessions sorted by routing name and excludes control sessions. `status` prints a JSON status object with `state`, `host`, `port`, `server_reachable`, `message`, `core_list_supported`, and `adapter_list_exposed` fields. `state` is one of `available`, `unavailable`, `auth_failed`, or `protocol_mismatch`; `status` returns exit code 0 so host tooling can inspect the state field.

Pi commands connect to the configured endpoint and authenticate with shared-secret challenge-response. Connection failures return a non-zero exit code for message, list, and shutdown operations. Protocol error envelopes returned to `send` or `broadcast`, such as `UNKNOWN_TARGET`, are printed to stdout and return a non-zero exit code. `shutdown` uses an authenticated control connection, prints `{"op": "shutdown_ok"}` on success, and closes connected sessions with a normal server-shutdown close.

## Development

From a checkout with the runtime environment installed, run the helper directly, e.g. `inter-agent-pi status --json`. To run the package-local gate (TypeScript + Python tests, lint, typecheck, build, and artifact validation), use `scripts/run-checks.sh` from the repository root.
