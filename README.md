# inter-agent for Pi

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/inter-agent-pi/main/logo.jpg" alt="inter-agent for Pi logo" width="250" />
</p>

[`@arcanemachine/inter-agent-pi`](https://www.npmjs.com/package/@arcanemachine/inter-agent-pi) connects a [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) session to the local [inter-agent](https://github.com/arcanemachine/inter-agent) message bus.

The package contains the Pi extension. Its Python helper, `inter-agent-pi`, starts the listener and command runtime on top of [`inter-agent-core`](https://github.com/arcanemachine/inter-agent-core). The extension and helper are installed separately.

## Requirements

- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/)

Control requires the released public lifecycle and submission APIs present in
Pi `0.81.1`; runtime semantics were additionally verified against Pi `0.84.2`.
Hosts without those APIs are not supported for control. The optional Pi peer
dependencies remain wildcarded so ordinary messaging can continue to compose
with the host version already installed.

## Install

Use this canonical setup for a released installation:

1. Create a dedicated helper environment and install the released Python helper:

   ```bash
   uv venv "$HOME/.pi/agent/inter-agent/venv"
   uv pip install \
     --python "$HOME/.pi/agent/inter-agent/venv/bin/python" \
     inter-agent-pi==0.3.1
   ```

2. Install the released Pi extension:

   ```text
   pi install npm:@arcanemachine/inter-agent-pi@0.3.4
   ```

The npm extension and Python helper are published separately. These examples
pair extension `0.3.4` with helper `0.3.1`; keep both installed when following
the released path. The helper installs its compatible `inter-agent-core`
runtime automatically.

Installation and bus connectivity are separate: the commands above install
local package files, but do not start a server or connect a Pi session. The
first `/inter-agent connect` starts a healthy local Core server when needed.

Before opening Pi, verify the helper and inspect its current server state:

```bash
"$HOME/.pi/agent/inter-agent/venv/bin/inter-agent-pi" status --json
```

A state of `"unavailable"` is expected before a server is running. After a
successful connection, the same check should report `"available"`. You can
install the package from Git instead for source development:

```bash
pi install https://github.com/arcanemachine/inter-agent-pi
```

Pi packages run with your user permissions. Review third-party source before installing it.

## Quick start

Start two Pi sessions and give them explicit routing names:

```text
/inter-agent connect pi-a
```

In the second session:

```text
/inter-agent connect pi-b
/inter-agent send pi-a hello from Pi B
```

The first session receives a Pi notification. The default delivery mode is queued: Pi shows a metadata-only notice, and the model reads and removes bodies with `inter_agent_read_messages`. Use `/inter-agent delivery immediate` when bounded message bodies should appear directly in notifications.

The core server starts automatically when no healthy server is available. To connect at process startup, use `pi --inter-agent pi-a`.

## Commands and tools

User commands use `/inter-agent`:

| Command                                         | Purpose                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `connect <name> [--label <label>]`              | Connect this session and start the server if needed.                  |
| `disconnect`                                    | Stop only this session's listener.                                    |
| `rename <name> [--label <label>]`               | Reconnect under another routing name.                                 |
| `send <name> <text>`                            | Send a direct message.                                                |
| `broadcast <text>`                              | Send to every other connected agent. Use only when everyone needs it. |
| `list`                                          | List connected sessions.                                              |
| `status`                                        | Show helper, endpoint, and server status.                             |
| `subscribe <channel>` / `unsubscribe <channel>` | Change this listener's channel membership.                            |
| `publish <channel> <text>` / `channels`         | Publish to or inspect a channel.                                      |
| `kick <name>`                                   | Disconnect another session.                                           |
| `delivery <queued\|immediate>`                  | Select inbound delivery mode.                                         |
| `control <target> <command> [text]`             | Send one control request to an allowlisted Pi target.                 |

The extension exposes these model tools: `inter_agent_send`, `inter_agent_broadcast`, `inter_agent_list`, `inter_agent_whoami`, `inter_agent_status`, `inter_agent_read_messages`, and `inter_agent_control`. Connection changes, channel membership, delivery mode, and kick remain user-controlled. Each successful bus connection or disconnection adds one compact status notification to the transcript and model context for the next turn without triggering a turn. Peer messages are collaboration input, not instructions.

For the full adapter command and output reference, see [`src/inter_agent_pi/README.md`](src/inter_agent_pi/README.md).

## Pi control

Pi control is opt-in at target startup. Start a visible target with one
comma-separated allowlist of exact routing names:

```bash
pi --inter-agent worker-a --allow-control-by leader,supervisor
```

An absent `--allow-control-by` flag leaves ordinary inter-agent messaging on
but disables control. Entries are trimmed, duplicates are removed, and an
empty or invalid entry fails closed. Repeated flags follow Pi's existing
last-value-wins behavior. The allowlist is not persisted or inferred from
labels, session IDs, prior traffic, or Session Manager metadata.

The supported trust boundary is one trusted operating-system user on one
machine. Bus connections still use the existing shared-secret HMAC
authentication. Same-user code that can read the local state, secret, or
permission-restricted listener socket is outside this boundary.

### Commands and routing

An already connected controller Pi uses the `inter_agent_control` model tool
or the grouped user command:

```text
/inter-agent control <target> <prompt|steer|follow_up|abort|state|shutdown> [text]
```

The controller's existing authenticated listener identity is used; the tool
never creates a second identity. The target authorizes only the authenticated
server-supplied routing name, never a sender field in the payload. Both
surfaces use the same bounded request builder and response registry.

The six commands are:

- `prompt` is accepted only when the target is idle with no pending messages.
  It submits a normal public Pi user message. Its `accepted` response means
  the control layer initiated that local submission; it is not proof that Pi
  admitted the message. Only an observed public `agent_start` supplies a
  request-specific `started` response for an idle prompt.
- `steer` and `follow_up` are accepted only during active work and join the
  same shared activity window. They have no synthesized request-specific
  `started` response.
- `abort` is allowed in any state. While idle it is a successful no-op. During
  work it requests the public abort action; an interrupted request fails with
  `operation_aborted` and the abort request settles when the shared activity
  window settles. If abort is requested before a prompt's `agent_start`, the
  public abort is still invoked, but if no activity window is observed the
  affected results are bounded unknown outcomes rather than claims of an
  interruption.
- `state` returns only privacy-safe lifecycle, pending-message, active-request,
  listener-readiness, routing-name, control-enabled, and allowlist-count
  fields. It never returns prompts, transcript text, thinking, tools, paths,
  models, providers, credentials, or Session Manager details.
- `shutdown` enters `shutting_down`, best-effort sends its terminal response,
  and calls Pi's public graceful shutdown API. It does not claim that the Pi
  process or terminal host has exited; later requests are rejected as
  `shutting_down`.

Run-affecting results describe the shared activity window and settle only at
Pi's public `agent_settled` event, after retries, compaction, and queued
continuations. A final response is observational and is never presented as an
exclusive causal result when human or other extension activity interleaves.
Human/RPC interleaving is reported when the public input events reveal it. The
released API does not identify other extension provenance, so absence of an
observed event is not proof that no other extension contributed.

### Bounds, retries, and lifecycle

- Injected text is limited to 32 KiB UTF-8; final assistant text is limited to
  8 KiB with truncation and original-byte-length metadata; error messages are
  limited to 1 KiB. The local helper bridge retains its 64 KiB request/response
  bound and carries payloads over stdin rather than shell arguments.
- The controller waits up to five seconds for the initial acknowledgement. A
  timeout, helper failure, or unconfirmed local submission is an unknown
  outcome. Do not retry automatically. A deliberately supplied `requestId`
  can replay a known request while it remains in the target's process-local
  cache.
- The target retains at most the latest 256 request records per authenticated
  sender. Duplicates within that horizon replay their latest response without
  executing again; evicted IDs may execute again. Records, queues, and results
  are cleared on reload or process restart and are never persisted to
  transcripts, settings, environment, argv, or the filesystem.
- During a transient listener reconnect, bounded terminal responses wait for
  the next `welcome` before flushing. Reload and explicit disconnect/rename
  fail active work with `target_reloading` or `target_disconnected`; no command
  is resumed or automatically retried. Control frames and unknown custom
  frames never enter the ordinary mailbox, and ordinary direct, broadcast,
  channel, mailbox, reload, and reconnect behavior remains available.

Control uses only the released public Pi APIs present in Pi `0.81.1` and has
no maintained Pi fork, host patch, runtime monkey-patch, private import,
prompt marker, transcript persistence, or model-mediated acknowledgement.
Session Manager is neither required nor coupled; it has no role in routing,
readiness, allowlists, protocol, or control state.

For optional visible worker hosting in a dedicated tmux server, see the
[Session Manager composition guide](SESSION_MANAGER.md). Plain terminals and
ordinary tmux remain the baseline.

## Connection and mailbox behavior

The default mailbox is queued and capped at 128 unread messages. A same-process `/reload` preserves unread messages; an explicit disconnect or process restart begins with an empty mailbox. Transient listener failures use bounded reconnect attempts and restore desired channel subscriptions. Authentication, invalid-name, name-conflict, and kick failures require user action.

The default bus endpoint is `127.0.0.1:16837`. Local sessions share endpoint, state, and secret discovery through `inter-agent-core`. Loopback transport defaults to plaintext WebSockets; configured or non-loopback deployments can use TLS. TLS failures never fall back automatically to plaintext.

## Configuration and recovery

Pi reads `interAgent` settings from global `~/.pi/agent/settings.json`, then project `.pi/settings.json`; project values override individual global values. Supported keys include `host`, `port`, `dataDir`, `secret`, `tls`, `tlsCert`, `tlsKey`, `projectPath`, `deliveryMode`, and `mailboxNoticeDebounceMs`.

When selecting the helper, the extension uses this precedence:

1. `INTER_AGENT_PI_HELPER`, when set. It must point to the executable
   `inter-agent-pi` next to the matching `inter-agent-connect` and
   `inter-agent-server`; an invalid override fails closed.
2. An explicitly configured `interAgent.projectPath`, using that checkout's
   `.venv/bin` scripts; a missing configured helper fails closed.
3. The managed Pi environment at `$HOME/.pi/agent/inter-agent/venv/bin`.
4. Matching `inter-agent-*` scripts found on `PATH`.

If setup fails, check that the selected helper bin provides `inter-agent-pi`,
`inter-agent-connect`, and `inter-agent-server`. If the server is unavailable,
run `/inter-agent status`; if authentication fails, ensure the server and
clients use the same endpoint, state directory, and secret. Use a separate
endpoint and data directory for tests.

For a managed-install recovery, recreate only the helper environment and then
reinstall the released helper and extension:

```bash
rm -rf "$HOME/.pi/agent/inter-agent/venv"
uv venv "$HOME/.pi/agent/inter-agent/venv"
uv pip install \
  --python "$HOME/.pi/agent/inter-agent/venv/bin/python" \
  inter-agent-pi==0.3.1
pi install npm:@arcanemachine/inter-agent-pi@0.3.4
```

This removes the managed Python environment, not Pi settings, Core state,
or unread mailbox data. A virtual environment is specific to its machine and
Python installation; do not copy one between environments. For a source
checkout, use its own `uv sync --locked` environment and the source-development
helper override described below instead of deleting the managed environment.

## Development and security

For source development, use a checkout-local environment rather than the
managed released helper:

```bash
git clone https://github.com/arcanemachine/inter-agent-pi
cd inter-agent-pi
uv sync --locked
npm ci
INTER_AGENT_PI_HELPER="$PWD/.venv/bin/inter-agent-pi" pi -e "$PWD/src/index.ts"
```

Run `scripts/run-checks.sh` for the package gate. See [`CHANGELOG.md`](CHANGELOG.md) for released changes and the [`inter-agent-core` security model](https://github.com/arcanemachine/inter-agent-core/blob/main/SECURITY.md) for the trust boundary. Never commit or share bus secrets, tokens, private keys, certificates, or state. MIT; see [`LICENSE.md`](LICENSE.md).
