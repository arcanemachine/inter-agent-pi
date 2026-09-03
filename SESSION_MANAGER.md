# Optional Session Manager composition

Plain Pi terminals and ordinary tmux remain the baseline. `pi-session-manager`
is an optional hosting layer for cases where a controller needs several
user-visible Pi workers in an isolated tmux server. It does not replace or
extend inter-agent semantics.

## Ownership boundary

Use the two layers for separate jobs:

- **Session Manager** creates, lists, views, retains, and removes Pi processes
  in its dedicated tmux server.
- **inter-agent Pi** owns routing names, authenticated presence, controller
  allowlists, readiness, prompts, steering, follow-ups, aborts, state, and
  graceful shutdown.

Session Manager does not inspect readiness, send prompts or keystrokes, infer
completion from terminal text, maintain an identity registry, or become a
runtime dependency of this package. A pane is an observation surface only.

Install and authorize Session Manager as described in its
[package README](https://github.com/arcanemachine/pi-projects/tree/main/packages/pi-session-manager),
then load the accepted `inter-agent-pi` extension and helper in each worker.
The two packages remain independently installable.

## Authorization and isolation

In the Manager Pi, a human must enable the process-local authorization gate:

```text
/session-manager configure
/session-manager status
```

Selecting **On** grants the Manager Pi visibility and process/window lifecycle
authority, including force termination. Authorization is not persisted,
passed to workers, or written to settings or transcripts. Keep the Manager Pi's
authorization separate from inter-agent's bus authentication and target
allowlists.

Session Manager uses a dedicated socket, normally:

```text
~/.pi/agent/pi-session-manager/tmux.sock
```

It never changes the user's default tmux server or terminal focus. The list
result includes the exact attachment command. Attach only when you want human
inspection; attachment is not required for agent operation.

## Start an isolated composition

For a normal setup, let all Pi processes use the same inter-agent endpoint and
settings. For a trial or a separate fleet, use a fresh loopback endpoint,
secret, and data directory. Keep the real secret in a permission-restricted
local settings file; never commit it or put it in `piArgs`.

A temporary project `.pi/settings.json` can select the accepted local helper
without relying on a per-worker environment override:

```json
{
  "interAgent": {
    "host": "127.0.0.1",
    "port": 16837,
    "dataDir": "/tmp/inter-agent-session-manager/data",
    "secret": "<local secret; do not commit>",
    "projectPaths": [
      "/host/path/to/inter-agent-pi",
      "/container/path/to/inter-agent-pi"
    ]
  }
}
```

`projectPaths` is always a non-empty list of non-empty checkout-path strings.
The extension resolves each candidate relative
to the settings file, checks candidates in order, and uses the first checkout
whose `.venv/bin` provides executable `inter-agent-pi`,
`inter-agent-connect`, and `inter-agent-server`. A malformed list or a list
with no valid candidate fails closed rather than falling through to another
helper. The former singular `projectPath` key is not supported; migrate it to
this list form. Use a short data path when the platform's Unix socket path
limit makes a deeply nested temporary directory fail. The Session Manager
package has no per-worker environment override, so create separate temporary
working folders when workers need separate project settings.

Create one ordinary interactive Pi instance per worker. `piArgs` is an opaque
array passed directly to `pi`; it is not shell syntax and Session Manager does
not interpret the arguments:

```json
{
  "fleet": "myproject-workers",
  "instance": 1,
  "cwd": "/tmp/myproject-workers/leader",
  "piArgs": [
    "--no-extensions",
    "--extension",
    "/path/to/inter-agent-pi/src/index.ts",
    "--inter-agent",
    "leader"
  ]
}
```

Use separate instances for the target and any other controller. A target opts
into control at startup with an exact allowlist:

```json
{
  "fleet": "myproject-workers",
  "instance": 2,
  "cwd": "/tmp/myproject-workers/worker-a",
  "piArgs": [
    "--no-extensions",
    "--extension",
    "/path/to/inter-agent-pi/src/index.ts",
    "--inter-agent",
    "worker-a",
    "--allow-control-by",
    "leader"
  ]
}
```

Use `pi_fleet_create` once per instance. Do not encode roles, readiness, tasks,
or an identity registry in Session Manager metadata. Those remain caller and
inter-agent concerns.

## Establish readiness and control

First use `pi_fleet_list` to confirm that the expected windows are running and
`inter_agent_list` (or the adapter's list command) to confirm the expected
routing names are present. Then request the target's privacy-safe `state`
through the controller's `inter_agent_control` tool or:

```text
/inter-agent control worker-a state
```

Readiness requires inter-agent presence and a structured control response. Do
not treat a successful `pi_fleet_create`, a running process, or text captured
from a pane as readiness.

The controller's authenticated routing name is what the target authorizes:

```text
/inter-agent control worker-a prompt <text>
/inter-agent control worker-a steer <text>
/inter-agent control worker-a follow_up <text>
/inter-agent control worker-a abort
/inter-agent control worker-a state
/inter-agent control worker-a shutdown
```

`prompt` requires an idle target; `steer` and `follow_up` join active work;
`abort` is available in any state; and `shutdown` requests Pi's public graceful
shutdown. The control response describes inter-agent's semantic activity. It
does not claim that the terminal host has exited.

Use `pi_fleet_view` only for bounded human or agent observation. It does not
change focus and its captured text is not completion or readiness evidence.

## Shutdown and cleanup

Prefer this sequence:

1. request `shutdown` through inter-agent;
2. wait for the target's structured response and process exit;
3. use `pi_fleet_list` to observe the retained `exited` instance;
4. use `pi_fleet_view` if you need its bounded exit details;
5. call `pi_fleet_close` for that exited instance.

Session Manager retains an exited pane until the dead-only close. If the final
managed window is removed, its fleet and dedicated tmux server may disappear
naturally. Do not use terminal keystrokes as a control protocol.

If graceful shutdown is unavailable or has failed, force escalation is a
separate destructive action. Confirm that no human tmux client is attached and
no Session Manager view is active, obtain explicit user authorization, and use
`pi_fleet_force_close` only with `confirmProcessTermination: true`. Never force
close a live worker merely because it is slow, and never remove an attached or
viewed pane.

## Failure ownership and troubleshooting

- **No routing presence or a rejected control request:** debug inter-agent
  endpoint, secret, helper selection, startup name, and target allowlist. Do
  not repair this through Session Manager metadata.
- **A window is missing or exited:** inspect it with Session Manager; preserve
  the Pi session history and source files unless a separate deletion operation
  was explicitly requested.
- **Unexpected terminal output:** treat it as observation and use inter-agent
  state/control responses for semantics.
- **Helper setup failure:** verify that each configured projectPaths
  candidate's `.venv/bin` (or the managed/PATH helper) provides
  `inter-agent-pi`, `inter-agent-connect`, and `inter-agent-server`.
- **Socket path failure:** move isolated bus data and temporary worker folders
  to a short path; do not switch to the user's default tmux server.

Session Manager's same-user socket access is operational isolation, not a
complete security boundary. Same-user code that can read the socket, bus
secret, or local state remains inside the accepted trust model.

## Verified composition

The optional composition is supported when readiness is established through
inter-agent presence and structured control responses rather than process
existence or pane text. Prompt, steer, follow-up, abort, state, and graceful
shutdown retain the ownership and lifecycle boundaries described above.

The provider-free inter-agent control checks cover the structured authorization
response. Session Manager remains optional: it does not become a runtime
dependency, change the default tmux server, inject terminal input, or handle
bus credentials.
