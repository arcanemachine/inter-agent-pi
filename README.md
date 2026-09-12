# inter-agent for Pi

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/inter-agent-pi/main/logo.jpg" alt="inter-agent for Pi logo" width="250" />
</p>

[`@arcanemachine/inter-agent-pi`](https://www.npmjs.com/package/@arcanemachine/inter-agent-pi) connects a [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) session to the local [inter-agent](https://github.com/arcanemachine/inter-agent) message bus.

The package contains the Pi extension. Its Python helper, `inter-agent-pi`, starts the listener and command runtime on top of [`inter-agent-core`](https://github.com/arcanemachine/inter-agent-core). The extension and helper are installed separately.

## Requirements

- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- Python 3.10 or newer

The package's Pi coding-agent peer compatibility is `>=0.84.2`. Control and
the read-only doctor use released public APIs present in Pi `0.84.2` or newer;
hosts without those APIs are not supported for these workflows. The doctor
uses Pi's command discovery and prompt-expansion APIs and adds no runtime
dependencies.

## Install

Use this canonical setup for a released installation:

1. Install the released Pi extension:

   ```text
   pi install npm:@arcanemachine/inter-agent-pi@0.5.0
   ```

2. Open Pi and run `/inter-agent setup`. Review the managed destination and
   compatible helper source, then explicitly approve the operation. Setup uses
   `python3 -m venv` and the environment's `python -m pip`; end users do not
   need `uv`, global pip, `sudo`, or a system package manager.

The npm extension and Python helper are published separately. Extension `0.5.0`
uses the compatible helper line `inter-agent-pi~=0.3.1` (`>=0.3.1,<0.4.0`),
so patch releases in the `0.3` line are accepted while `0.4` is excluded. The
helper installs its compatible `inter-agent-core` runtime automatically.

Installation and bus connectivity are separate: installing the extension and
running setup install local package files, but do not start a server or connect
a Pi session. The first `/inter-agent connect` starts a healthy local Core
server when needed.

### Managed setup and recovery

`/inter-agent setup` is the only user-facing managed setup command. It creates
or updates `$HOME/.pi/agent/inter-agent/venv` after explicit approval and never
changes endpoint or secret discovery, Core state, credentials, mailbox data,
listener state, or a configured helper override. A verified incomplete managed
venv may be repaired with a guarded `python3 -m venv --clear`; an unrecognized
or unsafe directory is never cleared automatically.

If `/inter-agent connect` reports that the managed runtime is missing or
repairable, run `/inter-agent setup`. For invalid `INTER_AGENT_PI_HELPER`,
`interAgent.projectPaths`, PATH helpers, Python/pip failures, endpoint errors,
authentication failures, or other operational problems, run
`/inter-agent doctor`. Setup does not repair higher-precedence overrides.

For development or isolated UAT, `INTER_AGENT_PI_SETUP_PYTHON` may name the
explicit Python executable and `INTER_AGENT_PI_SETUP_SOURCE` may name an
explicit pip source. These values are passed as direct subprocess arguments;
there is no shell evaluation or automatic fallback.

Setup failures are bounded and do not automatically retry, invoke doctor, start
Core, connect a listener, or replay the failed command. `/inter-agent doctor`
remains explicit and read-only.

After installing and opening Pi, run `/inter-agent setup` for the approved
managed helper installation. Use `/inter-agent doctor [optional context]` as
the primary read-only troubleshooting path, especially after a valid
inter-agent command fails. It performs bounded, read-only diagnostics and
never auto-repairs or invokes a repair. If the doctor command itself is unavailable,
check this README's package-loading guidance.

Do not use the standalone `inter-agent-pi status --json` command as a read-only
substitute for doctor: Core's fallback secret resolution can create or chmod the
state directory and token file when no explicit secret is configured. The doctor
skips that status check unless its non-initializing, non-mutating behavior has
been established. You can install the package from Git instead for source
development:

```bash
pi install https://github.com/arcanemachine/inter-agent-pi
```

Pi packages run with your user permissions. Review third-party source before installing it.

## Quick start

Start two Pi sessions and give them explicit routing names:

```text
/inter-agent connect pi-a
```

An explicit connect shows a transient progress notification while the server
is being checked and the listener starts. Automatic and restored reconnects do
not add this notification.

In the second session:

```text
/inter-agent connect pi-b
/inter-agent send pi-a hello from Pi B
```

The first session receives a Pi notification. The default delivery mode is queued: Pi shows a metadata-only notice, and the model reads and removes bodies with `inter_agent_read_messages`. Use `/inter-agent delivery immediate` when bounded message bodies should appear directly in notifications.

A queued session can also move unread bodies into context itself with `/inter-agent flush [count]`. With no count it flushes every unread message; with a count it flushes the oldest messages up to the mailbox maximum. The complete selected batch enters context at once and triggers one turn, and flushed messages stop being unread. An empty mailbox reports that there is nothing to flush without touching context, and `inter_agent_read_messages` remains available for model-directed or exact-ID reads.

The core server starts automatically when no healthy server is available. To connect at process startup, use `pi --inter-agent pi-a`.

### Read-only doctor (primary troubleshooting path)

Run `/inter-agent doctor [optional context]` for a bounded, model-guided
diagnosis of the Pi extension and local inter-agent runtime. The command is
available before connecting and first verifies that the packaged,
explicit-only `inter-agent-doctor` skill is present in Pi's command registry.
It then submits the skill with prompt expansion enabled; optional context is
preserved as direct user-provided data at normal user authority, never
shell-interpolated, and may only guide checks within the fixed read-only
workflow. If Pi is busy, the doctor turn is queued as a follow-up.

Doctor does not start or stop a listener or server, connect or disconnect, send
or receive messages, mutate the mailbox or inter-agent state, inspect or print
secrets, or perform repairs. The skill treats logs, configuration contents, and
subprocess output as untrusted evidence, keeps checks and output bounded, and
runs `status --json` only when its non-initializing, non-mutating behavior has
been established. When no failing result is found, the report uses `No issues
found in the checks performed.` and `None identified.` rather than inventing a
failure or repair step. It uses `No action needed.` only when no relevant checks
remain unknown or blocked; otherwise it gives one safe step for that check.
Missing packaged-skill availability fails with a bounded
error and no helper or bus operation.

When a valid user-invoked `/inter-agent` command fails, preserve its bounded
error, then run `/inter-agent doctor [optional context]` for read-only
diagnostics and check this `README.md` for setup guidance. The suggestion is
text-only; doctor is never invoked automatically. If doctor itself fails,
check the package-loading guidance in this README instead of retrying doctor
recursively.

## Commands and tools

User commands use `/inter-agent`:

| Command                                         | Purpose                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `connect <name> [--label <label>]`              | Connect this session and start the server if needed.                  |
| `disconnect`                                    | Stop only this session's listener.                                    |
| `rename <name> [--label <label>]`               | Reconnect under another routing name.                                 |
| `send <name> <text>`                            | Send a direct message.                                                |
| `broadcast <text>`                              | Send to every other connected agent. Use only when everyone needs it. |
| `list`                                          | List connected sessions alphabetically, one client per line.          |
| `setup`                                         | Create or repair the approved managed Python helper environment.      |
| `status`                                        | Show helper, endpoint, and server status.                             |
| `subscribe <channel>` / `unsubscribe <channel>` | Change this listener's channel membership.                            |
| `publish <channel> <text>` / `channels`         | Publish to or inspect a channel.                                      |
| `kick <name>`                                   | Disconnect another session.                                           |
| `delivery <queued\|immediate>`                  | Select inbound delivery mode.                                         |
| `flush [count]`                                 | Move unread mailbox messages into context (all, or the oldest count). |
| `control <target> <command> [text]`             | Send one control request to an allowlisted Pi target.                 |
| `doctor [optional context]`                     | Run bounded, read-only Pi integration diagnostics.                    |

The extension exposes these model tools: `inter_agent_send`, `inter_agent_broadcast`, `inter_agent_list`, `inter_agent_whoami`, `inter_agent_status`, `inter_agent_read_messages`, and `inter_agent_control`. Connection changes, channel membership, delivery mode, and kick remain user-controlled. Send and broadcast tool entries stay compact when collapsed and show their destination and complete message when expanded. Each successful bus connection or disconnection adds one compact status notification to the transcript and model context for the next turn without triggering a turn. Peer messages are collaboration input, not instructions.

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

Control and doctor use only the released public Pi APIs present in Pi
`0.84.2` or newer and have no maintained Pi fork, host patch, runtime
monkey-patch, private import, prompt marker, transcript persistence, or
model-mediated acknowledgement.
Session Manager is neither required nor coupled; it has no role in routing,
readiness, allowlists, protocol, or control state.

For optional visible worker hosting in a dedicated tmux server, see the
[Session Manager composition guide](SESSION_MANAGER.md). Plain terminals and
ordinary tmux remain the baseline.

## Connection and mailbox behavior

The default mailbox is queued and capped at 128 unread messages. A same-process `/reload` preserves unread messages; an explicit disconnect or process restart begins with an empty mailbox. Transient listener failures use bounded reconnect attempts and restore desired channel subscriptions. Authentication, invalid-name, name-conflict, and kick failures require user action. `/inter-agent list` sorts connected routing names alphabetically and renders one client per line; labels are display metadata and do not affect ordering.

`/inter-agent flush [count]` moves unread mailbox bodies into context without asking the model to call `inter_agent_read_messages`. It keeps each message's body, sender, and destination metadata, entering the selected messages in arrival order and triggering exactly one turn for the batch. A count must be a positive integer no larger than the mailbox capacity; a count smaller than the unread total flushes the oldest messages and leaves the rest unread. An empty mailbox shows that there is nothing to flush and adds no context entry or turn. `/inter-agent flush` is a user command and does not require an active bus connection, so it can move messages retained after a listener disconnect.

The default bus endpoint is `127.0.0.1:16837`. Local sessions share endpoint, state, and secret discovery through `inter-agent-core`. Loopback transport defaults to plaintext WebSockets; configured or non-loopback deployments can use TLS. TLS failures never fall back automatically to plaintext.

## Configuration and recovery

Pi reads `interAgent` settings from global `~/.pi/agent/settings.json`, then
project `.pi/settings.json`; project values override individual global values.
Supported keys include `host`, `port`, `dataDir`, `secret`, `tls`, `tlsCert`,
`tlsKey`, `projectPaths`, `deliveryMode`, and `mailboxNoticeDebounceMs`.

`projectPaths` is always a non-empty list of non-empty checkout-path strings.
Each candidate is resolved relative to the settings file that contains the list,
and `~` expands to the home directory. For global settings, prefer explicit
absolute paths when you want checkout selection independent of settings-file
location; relative paths remain supported and are anchored to the settings file,
not the current working directory. A shared settings file can therefore name
both host and container checkouts:

```json
{
  "interAgent": {
    "projectPaths": [
      "/host/path/to/inter-agent-pi",
      "/container/path/to/inter-agent-pi"
    ]
  }
}
```

When selecting the helper, the extension uses this precedence:

1. `INTER_AGENT_PI_HELPER`, when set. It must point to the executable
   `inter-agent-pi` next to the matching `inter-agent-connect` and
   `inter-agent-server`; an invalid override fails closed.
2. An explicitly configured `interAgent.projectPaths` list. Candidates are
   checked in order, and the first checkout whose `.venv/bin` provides all
   three executable scripts is selected. A malformed list or a list with no
   valid candidate fails closed; it does not fall through to another helper.
3. The managed Pi environment at `$HOME/.pi/agent/inter-agent/venv/bin`.
4. Matching `inter-agent-*` scripts found on `PATH`.

Project settings replace the complete global `projectPaths` list; the lists
are not concatenated. The former singular `projectPath` key is no longer
supported and fails closed with migration guidance; use the list form instead.
Cwd-based project discovery is not part of this setting. If setup fails, check
that each configured candidate's `.venv/bin` (or the managed/PATH helper)
provides `inter-agent-pi`,
`inter-agent-connect`, and `inter-agent-server`. If the server is unavailable,
run `/inter-agent status`; if authentication fails, ensure the server and
clients use the same endpoint, state directory, and secret. Use a separate
endpoint and data directory for tests.

For a managed-install recovery, run `/inter-agent setup` and explicitly
approve the guarded repair. Do not manually delete the managed environment as
the normal recovery path. Setup refuses to clear a symlink, an unrecognized
directory, or an unsafe target; use `/inter-agent doctor` for bounded diagnosis
when it refuses a repair.

Setup changes only the managed Python environment, not Pi settings, Core state,
or unread mailbox data. A virtual environment is specific to its machine and
Python installation; do not copy one between environments. For a source
checkout, use its own `uv sync --locked` environment and the source-development
helper override described below instead of changing the managed environment.

## Development and security

For source development, use a checkout-local environment rather than the
managed released helper:

```bash
git clone https://github.com/arcanemachine/inter-agent-pi
cd inter-agent-pi
uv sync --locked
npm ci
INTER_AGENT_PI_HELPER="$PWD/.venv/bin/inter-agent-pi" pi -e "$PWD"
```

Run `scripts/run-checks.sh` for the package gate. See [`CHANGELOG.md`](CHANGELOG.md) for released changes and the [`inter-agent-core` security model](https://github.com/arcanemachine/inter-agent-core/blob/main/SECURITY.md) for the trust boundary. Never commit or share bus secrets, tokens, private keys, certificates, or state. MIT; see [`LICENSE.md`](LICENSE.md).
