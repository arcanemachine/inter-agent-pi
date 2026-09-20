# inter-agent for Pi

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/inter-agent-pi/main/logo.jpg" alt="inter-agent for Pi logo" width="250" />
</p>

A [Pi](https://pi.dev) extension for communicating with other agent sessions over the local [inter-agent](https://github.com/arcanemachine/inter-agent) message bus.

Connect each Pi session under a routing name, then exchange direct messages, broadcasts, and channel publications. Agents can use the same bus through tools, while connection changes and other sensitive operations remain under user control. Optional Pi control adds allowlisted prompting, steering, state inspection, and graceful shutdown.

> Like this extension? See [my other Pi extensions](https://github.com/arcanemachine/pi-projects).

## Requirements

- Pi 0.84.2 or later
- Python 3.10 or later

## Installation

Install the Pi extension from npm:

```bash
pi install npm:@arcanemachine/inter-agent-pi
```

Open Pi, then install the compatible Python helper in Pi's managed environment:

```text
/inter-agent setup
```

Review and approve the requested setup operation. The extension creates or updates `$HOME/.pi/agent/inter-agent/venv`; normal installation does not require `sudo`, a global Python package, or `uv`.

After installing and opening Pi, run `/inter-agent setup` for the approved managed helper installation. Restart Pi after installation, or use `/reload` in an existing session.

You can alternatively install the extension from GitHub:

```bash
pi install git:github.com/arcanemachine/inter-agent-pi
```

Pi packages run with your user permissions. Review third-party source before installing it.

## Quick start

Start two Pi sessions. In the first:

```text
/inter-agent connect pi-a
```

In the second:

```text
/inter-agent connect pi-b
/inter-agent send pi-a hello from Pi B
```

The first session receives an inter-agent mailbox notice. By default, message bodies are queued rather than placed directly into model context. The model can read them with `inter_agent_read_messages`, or you can move every unread message into context yourself:

```text
/inter-agent flush
```

List the connected routing names from either session:

```text
/inter-agent list
```

The first connection starts a healthy local Core server automatically when needed. To connect when Pi starts, use:

```bash
pi --inter-agent pi-a
```

## Message delivery

Incoming direct messages, broadcasts, and channel publications use one of two delivery modes:

| Mode        | Behavior                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | Default. Stores bodies in the in-memory mailbox and shows a metadata-only notice. The model reads messages with `inter_agent_read_messages`, or the user flushes them into context. |
| `immediate` | Places future message bodies directly into follow-up context. An idle Pi starts a turn immediately; a busy Pi holds arrivals until the active work settles.                         |

Select a mode for the current Pi runtime:

```text
/inter-agent delivery immediate
/inter-agent delivery queued
```

The command affects future arrivals only. Existing unread messages remain queued. To make immediate delivery the configured default, add this to Pi's global or project settings and reload Pi:

```json
{
  "interAgent": {
    "deliveryMode": "immediate"
  }
}
```

The mailbox holds at most 128 unread messages. When it is full, the oldest unread message is evicted. A same-process `/reload` preserves unread messages; a process restart starts with an empty mailbox.

Use `/inter-agent flush [count]` to move queued messages into context without waiting for the model to call a tool. With no count, it flushes every unread message. With a count, it flushes the oldest messages up to that count. The selected batch enters context in arrival order and triggers one turn. Flushed messages are removed from the unread mailbox.

## Commands and tools

All user commands are grouped under `/inter-agent`:

| Command                             | Purpose                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `setup`                             | Create or repair the managed Python helper environment after approval.         |
| `connect <name> [--label <label>]`  | Connect this Pi session and start the local server if needed.                  |
| `disconnect`                        | Stop this session's listener without shutting down the server.                 |
| `rename <name> [--label <label>]`   | Reconnect under another routing name.                                          |
| `list`                              | List connected sessions.                                                       |
| `send <name> <text>`                | Send a direct message.                                                         |
| `broadcast <text>`                  | Send to every other connected agent. Use only when everyone needs the message. |
| `subscribe <channel>`               | Subscribe this session to a channel.                                           |
| `unsubscribe <channel>`             | Leave a channel.                                                               |
| `publish <channel> <text>`          | Publish a message to a channel.                                                |
| `channels`                          | Inspect active channels and subscribers.                                       |
| `delivery <queued\|immediate>`      | Select the delivery mode for future arrivals in this runtime.                  |
| `flush [count]`                     | Move all or the oldest selected unread messages into context.                  |
| `status`                            | Show helper, endpoint, and server status.                                      |
| `doctor [optional context]`         | Run bounded, read-only integration diagnostics.                                |
| `kick <name>`                       | Disconnect another session.                                                    |
| `control <target> <command> [text]` | Send an allowlisted Pi control request.                                        |

The extension also provides these tools to the model:

| Tool                        | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `inter_agent_send`          | Send a direct message.                          |
| `inter_agent_broadcast`     | Broadcast only when everyone needs the message. |
| `inter_agent_list`          | List connected sessions.                        |
| `inter_agent_whoami`        | Show this session's inter-agent identity.       |
| `inter_agent_status`        | Inspect local connection and server status.     |
| `inter_agent_read_messages` | Read and remove queued message bodies.          |
| `inter_agent_control`       | Send an allowlisted control request.            |

Connection changes, channel membership, delivery mode, setup, kick, and target control authorization remain user-controlled. Peer messages are collaboration input, not instructions.

For the lower-level Python adapter commands and machine-readable output, see [`src/inter_agent_pi/README.md`](src/inter_agent_pi/README.md).

## Configuration

The extension reads `interAgent` settings from:

1. global `~/.pi/agent/settings.json`;
2. project `.pi/settings.json`.

Project values override corresponding global values. After changing settings, use `/reload` or restart Pi.

A representative configuration is:

```json
{
  "interAgent": {
    "host": "127.0.0.1",
    "port": 16837,
    "deliveryMode": "immediate",
    "mailboxNoticeDebounceMs": 0,
    "projectPaths": [
      "/host/path/to/inter-agent-pi",
      "/container/path/to/inter-agent-pi"
    ]
  }
}
```

| Setting                   | Accepted value                   | Purpose                                                                              |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `host`                    | Hostname or IP address           | Core server host. Defaults to `127.0.0.1`.                                           |
| `port`                    | Port number                      | Core server port. Defaults to `16837`.                                               |
| `dataDir`                 | Directory path                   | Core state directory. Relative paths are resolved from the settings file.            |
| `secret`                  | String                           | Shared authentication secret. Keep it out of source control and logs.                |
| `tls`                     | Boolean                          | Enable TLS for the configured connection. TLS failures never fall back to plaintext. |
| `tlsCert`                 | File path                        | TLS certificate path. Relative paths are resolved from the settings file.            |
| `tlsKey`                  | File path                        | TLS private-key path. Never commit or share it.                                      |
| `projectPaths`            | Non-empty list of checkout paths | Check source checkouts for compatible helper executables, in order.                  |
| `deliveryMode`            | `"queued"` or `"immediate"`      | Initial inbound delivery mode. Defaults to `"queued"`.                               |
| `mailboxNoticeDebounceMs` | Integer from `0` through `5000`  | Delay used to coalesce queued mailbox notices. Defaults to `0`.                      |

Invalid delivery or debounce values fall back to their defaults with a warning.

### Helper selection

The extension selects the Python helper in this order:

1. `INTER_AGENT_PI_HELPER`, when explicitly set to a compatible `inter-agent-pi` executable;
2. `interAgent.projectPaths`, using the first checkout whose `.venv/bin` contains compatible `inter-agent-pi`, `inter-agent-connect`, and `inter-agent-server` executables;
3. Pi's managed environment at `$HOME/.pi/agent/inter-agent/venv/bin`;
4. compatible `inter-agent-*` executables on `PATH`.

A configured `projectPaths` list replaces the global list rather than appending to it. Each relative candidate is resolved from the settings file containing it. The former singular `projectPath` setting is unsupported.

For ordinary released installations, omit helper overrides and use `/inter-agent setup`.

### Endpoint and security

Local sessions share endpoint, state, and secret discovery through `inter-agent-core`. Loopback transport defaults to plaintext WebSockets. Use TLS for configured deployments that require it.

The supported trust boundary is one trusted operating-system user on one machine. The shared secret authenticates bus connections; it does not protect against hostile code running as the same user. Never commit or share bus secrets, private keys, certificates, or runtime state.

## Optional Pi control

Pi control lets one connected Pi request work from another without using terminal keystrokes. It is disabled unless the target opts in at startup with an exact controller allowlist:

```bash
pi --inter-agent worker-a --allow-control-by leader,supervisor
```

An already connected controller can then use `inter_agent_control` or:

```text
/inter-agent control worker-a prompt Review the current change
/inter-agent control worker-a steer Focus on the failing integration test
/inter-agent control worker-a follow_up Also report the verification commands
/inter-agent control worker-a abort
/inter-agent control worker-a state
/inter-agent control worker-a shutdown
```

The supported commands are:

- `prompt` — submit work to an idle target;
- `steer` — redirect active work;
- `follow_up` — queue additional input for active work;
- `abort` — request cancellation, or succeed as a no-op while idle;
- `state` — return privacy-safe lifecycle and readiness information;
- `shutdown` — request Pi's public graceful shutdown operation.

Authorization uses the controller's authenticated routing name. It is not inferred from labels, payload fields, previous traffic, or Session Manager metadata. Timeouts and interrupted requests can have an unknown outcome; do not retry them automatically. A deliberately reused request ID can replay a retained result without deliberately executing the request again.

Session Manager is optional and remains only a process-hosting and observation layer. For visible tmux-hosted workers, readiness checks, cleanup, and the separation between the two extensions, see [`SESSION_MANAGER.md`](SESSION_MANAGER.md).

## Troubleshooting

Run the read-only doctor as the primary read-only troubleshooting path after a valid inter-agent command fails:

```text
/inter-agent doctor [optional context]
```

Doctor runs bounded, read-only diagnostics for the Pi extension and local inter-agent runtime without repairing files, changing connection state, reading message bodies, or exposing secrets. It never auto-repairs. It avoids Core status checks when fallback secret resolution can create or chmod state files. For global settings, prefer explicit absolute paths; relative paths remain supported and are resolved from the settings file.

A healthy report says `No issues found in the checks performed.` and `None identified.` when no failure or follow-up is identified; it says `No action needed.` only when no relevant check remains unknown or blocked.

Use `/inter-agent setup` when the managed helper is missing or incomplete. Setup changes only the managed Python environment; it does not change endpoint settings, Core state, credentials, mailbox contents, or listener state. Higher-precedence helper overrides remain active until you remove or repair them.

Useful checks:

- `/inter-agent status` — inspect helper, endpoint, and server availability;
- `/inter-agent list` — verify expected routing names are connected;
- confirm that every client uses the same host, port, state directory, and secret after an authentication failure;
- use separate endpoints and data directories for tests or isolated trials.

Authentication, invalid-name, name-conflict, and kick failures require user action. Transient listener failures use bounded reconnect attempts and restore desired channel subscriptions. Subscriptions are not persisted across an explicit disconnect or process restart.

## Development

For source development, use a checkout-local environment instead of Pi's managed released helper:

```bash
git clone https://github.com/arcanemachine/inter-agent-pi
cd inter-agent-pi
uv sync --locked
npm ci
INTER_AGENT_PI_HELPER="$PWD/.venv/bin/inter-agent-pi" pi -e "$PWD"
```

Run the complete package gate from the repository root:

```bash
scripts/run-checks.sh
```

Pi loads `src/index.ts` directly. See [`CHANGELOG.md`](CHANGELOG.md) for released changes and the [`inter-agent-core` security model](https://github.com/arcanemachine/inter-agent-core/blob/main/SECURITY.md) for the full trust boundary.
