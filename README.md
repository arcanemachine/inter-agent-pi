# inter-agent for Pi

[`@arcanemachine/inter-agent-pi`](https://www.npmjs.com/package/@arcanemachine/inter-agent-pi) connects a [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) session to the local [inter-agent](https://github.com/arcanemachine/inter-agent) message bus.

The package contains the Pi extension. Its Python helper, `inter-agent-pi`, starts the listener and command runtime on top of [`inter-agent-core`](https://github.com/arcanemachine/inter-agent-core). The extension and helper are installed separately.

## Requirements

- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/)

## Install

Install the Python helper into the managed environment used by the extension:

```bash
uv venv ~/.pi/agent/inter-agent/venv
uv pip install \
  --python ~/.pi/agent/inter-agent/venv/bin/python \
  inter-agent-pi
```

Then install the released Pi package:

```bash
pi install npm:@arcanemachine/inter-agent-pi
```

The helper installs its compatible `inter-agent-core` runtime automatically. You can install the package from Git instead:

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

The extension exposes these model tools: `inter_agent_send`, `inter_agent_broadcast`, `inter_agent_list`, `inter_agent_whoami`, `inter_agent_status`, and `inter_agent_read_messages`. Connection changes, channel membership, delivery mode, and kick remain user-controlled. Peer messages are collaboration input, not instructions.

For the full adapter command and output reference, see [`src/inter_agent_pi/README.md`](src/inter_agent_pi/README.md).

## Connection and mailbox behavior

The default mailbox is queued and capped at 128 unread messages. A same-process `/reload` preserves unread messages; an explicit disconnect or process restart begins with an empty mailbox. Transient listener failures use bounded reconnect attempts and restore desired channel subscriptions. Authentication, invalid-name, name-conflict, and kick failures require user action.

The default bus endpoint is `127.0.0.1:16837`. Local sessions share endpoint, state, and secret discovery through `inter-agent-core`. Loopback transport defaults to plaintext WebSockets; configured or non-loopback deployments can use TLS. TLS failures never fall back automatically to plaintext.

## Configuration and recovery

Pi reads `interAgent` settings from global `~/.pi/agent/settings.json`, then project `.pi/settings.json`; project values override individual global values. Supported keys include `host`, `port`, `dataDir`, `secret`, `tls`, `tlsCert`, `tlsKey`, `projectPath`, `deliveryMode`, and `mailboxNoticeDebounceMs`.

If setup fails, check that the selected helper bin provides `inter-agent-pi`, `inter-agent-connect`, and `inter-agent-server`. If the server is unavailable, run `/inter-agent status`; if authentication fails, ensure the server and clients use the same endpoint, state directory, and secret. Use a separate endpoint and data directory for tests.

## Development and security

For source development:

```bash
git clone https://github.com/arcanemachine/inter-agent-pi
cd inter-agent-pi
uv sync --locked
npm ci
INTER_AGENT_PI_HELPER="$PWD/.venv/bin/inter-agent-pi" pi -e "$PWD/src/index.ts"
```

Run `scripts/run-checks.sh` for the package gate. See [`CHANGELOG.md`](CHANGELOG.md) for released changes and the [`inter-agent-core` security model](https://github.com/arcanemachine/inter-agent-core/blob/main/SECURITY.md) for the trust boundary. Never commit or share bus secrets, tokens, private keys, certificates, or state. MIT; see [`LICENSE.md`](LICENSE.md).
