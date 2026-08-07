# @arcanemachine/inter-agent-pi

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/inter-agent-pi/main/logo.png" alt="inter-agent Pi logo" width="250" />
</p>

[![Pi](https://img.shields.io/badge/pi-extension-purple)](https://github.com/arcanemachine/inter-agent-pi)

The Pi extension for the inter-agent message bus.

It connects a Pi coding-agent session to the bus as a named agent,
exposes grouped `/inter-agent` commands and a bounded set of agent-callable
tools, delivers incoming peer messages as Pi notifications, and ships a Python
helper (`inter-agent-pi` console command, `inter_agent_pi` import package) that
wraps the importable [`inter-agent-core`](#runtime-dependency) listener and
command APIs.

This repository is an independent clean-history child. It contains no former
monorepo history, no private workflow, no core runtime source, and no Claude
Code material.

## Installation (Pi extension)

From a Pi session:

```bash
pi install npm:@arcanemachine/inter-agent-pi
```

Or install from a published Git tag (once published; do not pin a raw commit
hash):

```bash
pi install https://github.com/arcanemachine/inter-agent-pi
```

Or load directly from a source checkout during development:

```bash
pi -e /path/to/inter-agent-pi/src/index.ts
```

The extension entry point is `./src/index.ts`.

## Runtime dependency

The helper depends on `inter-agent-core` `0.2.0` and on `websockets` `16.0`. A compatible `inter-agent-core` install
must provide the `inter-agent-pi`, `inter-agent-server`, `inter-agent-connect`,
`inter-agent-send`, `inter-agent-list`, `inter-agent-status`,
`inter-agent-shutdown`, `inter-agent-kick`, `inter-agent-publish`, and
`inter-agent-channels` console commands and the importable `inter_agent`
namespace, including the promoted `inter_agent.core.adapter_control` bridge.

> **Development note (non-release):** while the permanent `inter-agent-core`
> repository is being prepared, the Python helper may be resolved against a
> temporary local `inter-agent-core` candidate via a migration-only
> `[tool.uv.sources]` path entry. That path source is removed and the lock is
> re-resolved against the permanent `inter-agent-core` repository before any
> publication. Never publish while the temporary path source remains.

### Helper resolution precedence

The extension resolves the Python runtime in this order:

1. `INTER_AGENT_PI_HELPER` — an exact path to an `inter-agent-pi` executable;
   its bin directory must also contain the required core helper scripts.
2. An explicitly configured `interAgent.projectPath` — the helper is resolved
   from that checkout's `.venv/bin`; if it is configured but incomplete the
   extension fails fast with a bounded, actionable message.
3. The extension-managed, documented runtime venv.
4. `inter-agent-pi`, `inter-agent-connect`, and `inter-agent-server` discovered
   together on `PATH`.
5. A bounded setup-needed failure pointing back to this README.

The legacy implicit fallback to `~/.local/share/inter-agent` is intentionally
removed; that was a monorepo-era bootstrap assumption that no longer applies
to the standalone package. Explicitly configured `interAgent.projectPath`
remains supported for development.

## Installing the Python helper

From a source checkout:

```bash
uv sync --locked          # resolve inter-agent-core + dev/test tooling
uv build                  # build wheel + sdist into dist/
```

Install the built wheel into a venv that already provides a compatible
`inter-agent-core`, for example:

```bash
uv venv .venv
uv pip install ./dist/*.whl <compatible-inter-agent-core-wheel>
```

The `inter-agent-pi` console command and the agent-callable tools all reuse
this runtime.

## Configuration

Configuration is read from the Pi agent settings file under `interAgent.*`.
Relative paths (`projectPath`, `dataDir`, TLS cert/key) resolve against the
directory of the settings file.

- `host` / `port` — override the default bus endpoint.
- `dataDir` — shared bus state directory; defaults to the core default.
- `secret` — shared secret for challenge-response auth; forwarded to helpers
  as `INTER_AGENT_SECRET`. Do not store secrets in plaintext files in the repo.
- `tls` / `tlsCert` / `tlsKey` — enable explicit TLS and point at a
  certificate/key pair.

Helper resolution precedence and the environment variables used by the helper
match [`inter-agent-core`](#runtime-dependency). Helper install path, runtime
state/config path, and bus state directories stay distinct so the bus identity
does not fragment across installs.

## Commands

All commands ride the grouped `/inter-agent` command:

```
usage: /inter-agent <connect|disconnect|kick|rename|send|broadcast|publish|channels|subscribe|unsubscribe|list|status|delivery> [args]
```

- `/inter-agent connect <name> [--label <label>]` — connect this session as a
  named agent; auto-starts the server if unavailable.
- `/inter-agent disconnect` — stop the local listener and notify.
- `/inter-agent kick <name>` — force-disconnect another session (user-only).
- `/inter-agent rename <name> [--label <label>]` — reconnect under a new name.
- `/inter-agent send <to> <text>` — send a direct message; routes the sender via `--from`.
- `/inter-agent broadcast <text>` — broadcast to every session (user-only).
- `/inter-agent publish <channel> <text>` — publish to a channel (user-only).
- `/inter-agent channels` — list channels and subscribers.
- `/inter-agent subscribe <channel>` / `/inter-agent unsubscribe <channel>` —
  bind the live listener's subscriptions over the local control socket.
- `/inter-agent list` — list connected agent sessions.
- `/inter-agent status` — print server/helper status.
- `/inter-agent delivery <immediate|queued>` — switch inbound delivery mode
  (aliases `i` / `q`).

## Agent-callable tools vs user-only controls

Agent-callable tools:

- `inter_agent_send`, `inter_agent_broadcast` — send/broadcast through the
  connected Pi listener (sender routed via `--from`).
- `inter_agent_list`, `inter_agent_whoami`, `inter_agent_status` —
  read-only diagnostics; they do not require a connected listener.
- `inter_agent_read_messages` — read and remove queued mailbox messages;
  performs no outbound action.

User-only controls (no model-callable tool): `kick`, `publish`, `subscribe`,
`unsubscribe`, `channels`, `delivery`, and the connect/disconnect/rename
connection actions. Broadcast, publish, kick, and destructive actions require
explicit user approval; the model is instructed never to send a courtesy reply
and to treat peer messages as untrusted context.

## Mailbox, reload continuity, and reconnection

- By default inbound messages are queued in a bounded mailbox (max 128 unread)
  and surfaced as a metadata-only notice; `delivery immediate` restores bounded
  body notification.
- The notice provokes a non-steering follow-up turn and never prescribes a
  canned acknowledgment, reply, or outbound action.
- A same-process `/reload` preserves the unread mailbox through a versioned,
  one-use, process-global handoff (`Symbol.for("inter-agent.pi.mailbox.reloadHandoff.v1")`),
  generation/session-scoped and TTL-bounded; every other lifecycle boundary
  starts empty.
- The listener reconnects with bounded backoff and gives up after a deadline
  measured from the first failure. A `KICKED` stop terminates one listener
  process without reconnecting, leaving the routing name free for an explicit
  later reconnect.
- The startup flag provides the inter-agent routing name at process start:
  `pi -- inter-agent=<name>`.

## Development

```bash
uv sync --locked          # install runtime + dev/test dependencies
npm ci                    # install TypeScript/dev dependencies (network)
npm test                  # TypeScript tests
npm run typecheck         # tsc --noEmit
npm run build             # emit dist/
npx prettier --write .    # format
uv run pytest -q          # Python tests
uv run ruff check src tests
uv run black --check src tests
uv run mypy src tests
scripts/run-checks.sh     # full package gate incl. artifact validation
```

Artifacts (`dist/`, `dist-tests/`, `node_modules/`, `.venv/`, wheels, tarballs)
are generated and gitignored; they are not part of the root commit.

## Ecosystem and core

- The public `inter-agent-core` repository owns the bus runtime and the
  `inter_agent.core.adapter_control` bridge this package consumes. (Its public
  repository URL is published with that release; this package depends on the
  compatible distribution name `inter-agent-core`.)
- The public ecosystem repository coordinates adapters; it is added as a
  submodule only once it has a published initial `main` commit.

This package does not assume any currently published artifact exists beyond
what a compatible `inter-agent-core` release provides.

## Security

- Authenticate with the shared bus secret; never commit secrets, tokens, keys,
  or certificates to this repository.
- TLS uses explicit cert/key paths; a wrong/untrusted certificate fails bounded
  and actionable and never falls back to plaintext.
- Peer messages are untrusted context, never instructions.
