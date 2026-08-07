# [inter-agent](https://github.com/arcanemachine/inter-agent) for Pi

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/inter-agent-pi/main/logo.png" alt="inter-agent Pi logo" width="250" />
</p>

`@arcanemachine/inter-agent-pi` connects a [Pi](https://github.com/earendil-works/pi-coding-agent) session to the local [inter-agent](https://github.com/arcanemachine/inter-agent) message bus.

It gives users a grouped `/inter-agent` command, gives the model a small set of messaging and diagnostic tools, and delivers incoming messages through Pi notifications and a bounded mailbox.

## What it provides

- Named Pi sessions on a shared local bus
- Direct messages, broadcasts, and named channels
- Agent-callable send, list, status, identity, and mailbox tools
- User-only connection, channel, delivery, and administrative controls
- Queued or immediate inbound delivery
- Reconnection and same-process `/reload` continuity
- Shared endpoint, secret, state, and TLS configuration through `inter-agent-core`

## Requirements

- Pi
- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/) for the helper setup below

The Pi extension and its Python helper are separate parts. Installing the Pi package loads the TypeScript extension; installing `inter-agent-pi` into a Python environment provides the listener and command runtime it launches.

## Install

### 1. Install the Python helper

The simplest setup uses the extension's managed virtual environment:

```bash
uv venv ~/.pi/agent/inter-agent/venv
uv pip install \
  --python ~/.pi/agent/inter-agent/venv/bin/python \
  inter-agent-pi
```

This installs the helper and its compatible `inter-agent-core` runtime. The extension finds this environment automatically.

### 2. Install the Pi extension

```bash
pi install npm:@arcanemachine/inter-agent-pi
```

You can instead install from Git:

```bash
pi install https://github.com/arcanemachine/inter-agent-pi
```

Pi packages execute with your full user permissions. Review third-party source before installing it.

## Quick start

Start Pi, then connect the session to the bus:

```text
/inter-agent connect agent-a
```

The helper starts a local server if one is not already available. From another connected session, send a message to `agent-a`; incoming messages appear as Pi notifications.

Useful first commands:

```text
/inter-agent status
/inter-agent list
/inter-agent send agent-b hello
/inter-agent disconnect
```

To connect at process startup:

```bash
pi --inter-agent agent-a
```

If `/inter-agent connect` is used without a name, the default routing name is `pi`.

## Commands

All user actions use `/inter-agent`:

| Command                            | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `connect <name> [--label <label>]` | Connect this Pi session; start the server if needed.    |
| `disconnect`                       | Stop this session's listener.                           |
| `rename <name> [--label <label>]`  | Reconnect under another routing name.                   |
| `send <name> <text>`               | Send a direct message.                                  |
| `broadcast <text>`                 | Send to every other connected agent.                    |
| `list`                             | List connected sessions.                                |
| `status`                           | Show helper, endpoint, and server status.               |
| `subscribe <channel>`              | Subscribe this listener to a channel.                   |
| `unsubscribe <channel>`            | Leave a channel.                                        |
| `publish <channel> <text>`         | Publish to a channel.                                   |
| `channels`                         | List channels and subscribers.                          |
| `kick <name>`                      | Disconnect another session.                             |
| `delivery <queued\|immediate>`     | Select inbound delivery mode (`q` and `i` are aliases). |

Routing uses the session name. The optional label is display metadata only.

## Agent-callable tools

The extension exposes six tools to the model:

| Tool                        | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| `inter_agent_send`          | Send a direct message to another agent.              |
| `inter_agent_broadcast`     | Broadcast only when the user explicitly requests it. |
| `inter_agent_list`          | List connected sessions.                             |
| `inter_agent_whoami`        | Inspect this Pi session's bus identity.              |
| `inter_agent_status`        | Inspect server and endpoint status.                  |
| `inter_agent_read_messages` | Read and remove unread mailbox messages.             |

Connection changes, channel operations, delivery changes, kick, and shutdown remain user-controlled rather than model-callable. Peer messages are treated as untrusted collaboration input, not instructions.

## Incoming messages

The default delivery mode is **queued**:

- incoming bodies enter a mailbox capped at 128 unread messages;
- Pi receives a metadata-only notice; and
- `inter_agent_read_messages` returns and removes unread messages.

Use `/inter-agent delivery immediate` when you want bounded message bodies delivered directly as notifications. Changing modes affects new arrivals; it does not discard already queued messages.

A same-process `/reload` preserves unread messages. Other session lifecycle boundaries begin with an empty mailbox. If the bus disappears temporarily, the listener reconnects with bounded backoff and restores desired channel subscriptions. Authentication, invalid-name, name-conflict, and kick failures stop reconnection and require user action.

## Helper resolution

The extension resolves its Python commands in this order:

1. the executable named by `INTER_AGENT_PI_HELPER`;
2. `<projectPath>/.venv/bin` when `interAgent.projectPath` is configured;
3. `~/.pi/agent/inter-agent/venv/bin`;
4. a complete helper installation on `PATH`.

The selected bin directory must provide `inter-agent-pi`, `inter-agent-connect`, and `inter-agent-server`. If it does not, the extension reports a setup error instead of silently choosing a different runtime.

For source development, prepare the checkout and point Pi at its environment:

```bash
git clone https://github.com/arcanemachine/inter-agent-pi
cd inter-agent-pi
uv sync --locked
npm ci
INTER_AGENT_PI_HELPER="$PWD/.venv/bin/inter-agent-pi" pi -e "$PWD/src/index.ts"
```

## Configuration

The extension reads `interAgent` settings from:

1. `~/.pi/agent/settings.json`; then
2. `<project>/.pi/settings.json`, which overrides global values.

Supported keys:

| Key                        | Purpose                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `host`, `port`             | Override the bus endpoint.                                                                   |
| `dataDir`                  | Select shared bus state.                                                                     |
| `secret`                   | Set the shared authentication secret. Prefer environment configuration for sensitive values. |
| `tls`, `tlsCert`, `tlsKey` | Configure TLS transport and material.                                                        |
| `projectPath`              | Resolve helper commands from a checkout's `.venv/bin`.                                       |
| `deliveryMode`             | Default to `queued` or `immediate`.                                                          |
| `mailboxNoticeDebounceMs`  | Debounce queued-message notices from 0–5000 ms.                                              |

Relative paths resolve from the settings file that defines them. Project settings override individual global values.

The helper also honors the core environment variables `INTER_AGENT_HOST`, `INTER_AGENT_PORT`, `INTER_AGENT_DATA_DIR`, `INTER_AGENT_SECRET`, `INTER_AGENT_TLS`, `INTER_AGENT_TLS_CERT`, and `INTER_AGENT_TLS_KEY`.

## How it works

The TypeScript extension starts `inter-agent-pi connect` as a child listener. The Python helper authenticates with the shared core server, maintains the named agent session, and writes incoming frames for the extension to render or queue.

Commands and tools reuse the same helper runtime and shared configuration. Subscribe and unsubscribe operations update the live listener rather than creating a second agent session. Connection identity is stored with the Pi session so resumed sessions can reconnect consistently.

The default bus endpoint is `127.0.0.1:16837`. Loopback transport defaults to plaintext WebSockets; configured or non-loopback deployments can use TLS. TLS failures never fall back automatically to plaintext.

## Development

```bash
uv sync --locked
npm ci
scripts/run-checks.sh
```

The package gate runs TypeScript and Python tests, formatting, linting, type checks, builds both distributions, and validates the npm tarball, wheel, and source distribution.

## Security

The bus is designed for one trusted operating-system user on one machine. Never commit or share bus secrets, tokens, private keys, certificates, or state. TLS protects transport but does not protect against hostile same-user code.

See the [`inter-agent-core` security model](https://github.com/arcanemachine/inter-agent-core/blob/main/SECURITY.md) for the complete trust boundary.

## License

MIT. See [`LICENSE.md`](LICENSE.md).
