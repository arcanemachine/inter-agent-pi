# Changelog

All notable changes to the `inter-agent-pi` package are recorded here.
This repository begins with a clean one-commit history; the baseline below is
the split-generation source extracted from the coordinated monorepo
`0.2.0` split generation.

## 0.3.1 — npm publish checks

- Added npm prepublish checks for formatting, typechecking, tests, and build.

## 0.3.0 — Pi control implementation

- Added opt-in `pi.control.v1` target control for `prompt`, `steer`,
  `follow_up`, `abort`, `state`, and graceful `shutdown` through the
  controller's existing authenticated Pi identity.
- Added the `inter_agent_control` model tool, grouped `/inter-agent control`
  command, strict allowlist and payload validation, bounded responses,
  activity-window settlement, observed interleaving reporting, deduplication,
  reconnect handling, and unknown-outcome/no-automatic-retry semantics.
- Documented the one-user/one-machine trust boundary, public Pi API
  compatibility, privacy limits, ordinary messaging compatibility, and the
  Session Manager separation.
- Updated the helper and npm extension metadata to compatible `0.3.0` values;
  the development lock resolves the accepted immutable Core commit while
  built Python artifacts retain the registry dependency metadata.
- Added the centered README logo used by the Pi package gallery.

## 0.2.1 — npm gallery metadata

- Added the Pi gallery logo and `pi.image` metadata.
- Updated the scoped npm installation example.
- Python helper version remains `0.2.0`.

## 0.2.0 — split-generation baseline

Initial standalone repository for the Pi extension and its Python helper.
Extracted as a clean-history child from the frozen monorepo split source; the
Python helper and npm extension releases are versioned independently.

### Added

- Pi extension (`@arcanemachine/inter-agent-pi` on npm/Pi) exposing grouped commands —
  `connect`, `disconnect`, `kick`, `rename`, `send`, `broadcast`, `publish`,
  `channels`, `subscribe`, `unsubscribe`, `list`, `status`, `delivery` — and
  the agent-callable tools `inter_agent_send`, `inter_agent_broadcast`,
  `inter_agent_list`, `inter_agent_whoami`, `inter_agent_status`, and
  `inter_agent_read_messages`.
- Python helper distribution `inter-agent-pi` with the `inter_agent_pi`
  import package and the `inter-agent-pi` console command, wrapping the
  importable `inter-agent-core` command and listener APIs.
- Local Unix-domain control bridge consumed from `inter_agent.core.adapter_control`
  for live `subscribe` / `unsubscribe`.
- Queued mailbox delivery by default with a metadata-only notice, plus an
  opt-in `immediate` delivery mode; bounded unread mailbox preserved across a
  same-process `/reload` through a versioned, one-use, process-global handoff.
- Automatic listener reconnection with bounded backoff and give-up; terminal
  `KICKED` handling that stops one listener process without reconnecting.
- Plaintext and explicit TLS support, sharing the default bus state and secret
  resolution from `inter-agent-core`.

### Runtime dependency

- Depends on `inter-agent-core` (`0.2.0`) and `websockets` (`16.0`). The
  committed prepublication lock resolves core from the permanent core root
  pinned in `tool.uv.sources`; extension release work removes that source and
  re-locks against the published core package before publication.
