from __future__ import annotations

import asyncio
import io
import json
import subprocess
from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout, suppress
from dataclasses import dataclass
from pathlib import Path

import pytest
import websockets
from conftest import LiveServer
from inter_agent.core.auth import client_handshake
from inter_agent.core.client import build_hello
from inter_agent.core.server import run_server
from inter_agent.core.shared import control_hello
from websockets.asyncio.client import ClientConnection

from inter_agent_pi import commands as pi_commands
from inter_agent_pi.cli import main as pi_main
from inter_agent_pi.listener import run_listener

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class CommandCapture:
    code: int
    stdout: str
    stderr: str


def run_pi(args: list[str]) -> CommandCapture:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = pi_main(args)
    return CommandCapture(code=code, stdout=stdout.getvalue(), stderr=stderr.getvalue())


def run_pi_function(function: Callable[..., int], *args: object) -> CommandCapture:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = function(*args)
    assert isinstance(code, int)
    return CommandCapture(code=code, stdout=stdout.getvalue(), stderr=stderr.getvalue())


def use_short_data_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
    server: LiveServer,
) -> None:
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))
    monkeypatch.setenv("INTER_AGENT_SECRET", server.secret)


def use_live_pi_defaults(monkeypatch: pytest.MonkeyPatch, server: LiveServer) -> None:
    monkeypatch.setenv("INTER_AGENT_HOST", server.host)
    monkeypatch.setenv("INTER_AGENT_PORT", str(server.port))


async def wait_for_pi_status_state(state: str) -> dict[str, object]:
    deadline = asyncio.get_running_loop().time() + 1
    last_payload: dict[str, object] = {}
    while asyncio.get_running_loop().time() < deadline:
        status = await asyncio.to_thread(run_pi, ["status", "--json"])
        last_payload = json.loads(status.stdout)
        if last_payload.get("state") == state:
            return last_payload
        await asyncio.sleep(0.02)
    return last_payload


async def recv_json(ws: ClientConnection) -> dict[str, object]:
    response: object = json.loads(await ws.recv())
    assert isinstance(response, dict)
    return {str(key): value for key, value in response.items()}


async def send_json(ws: ClientConnection, payload: object) -> dict[str, object]:
    await ws.send(json.dumps(payload))
    return await recv_json(ws)


async def connect_agent(
    ws: ClientConnection,
    server: LiveServer,
    session_id: str,
    name: str,
    label: str | None = None,
) -> None:
    response = json.loads(
        await client_handshake(ws, server.secret, build_hello(session_id, name, label))
    )
    assert response["op"] == "welcome"


async def connect_control(ws: ClientConnection, server: LiveServer, session_id: str) -> None:
    response = json.loads(await client_handshake(ws, server.secret, control_hello(session_id)))
    assert response["op"] == "welcome"


async def assert_no_message(ws: ClientConnection) -> None:
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(ws.recv(), timeout=0.1)


@pytest.mark.asyncio
async def test_pi_status_reports_available_without_connected_agent(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)

    result = await asyncio.to_thread(run_pi, ["status", "--json"])

    payload = json.loads(result.stdout)
    assert result.code == 0
    assert result.stderr == ""
    assert payload["state"] == "available"
    assert payload["host"] == live_server.host
    assert payload["port"] == live_server.port
    assert payload["server_reachable"] is True
    assert payload["core_list_supported"] is True
    assert payload["adapter_list_exposed"] is True


@pytest.mark.asyncio
async def test_pi_cli_list_reports_live_agent_sessions(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)
    async with websockets.connect(live_server.url) as agent:
        await connect_agent(agent, live_server, "a", "agent-a", "Agent A")

        result = await asyncio.to_thread(run_pi, ["list"])

    assert result.code == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {
        "op": "list_ok",
        "sessions": [{"session_id": "a", "name": "agent-a", "label": "Agent A"}],
    }


@pytest.mark.asyncio
async def test_pi_cli_list_reports_empty_sessions_when_no_agents_connected(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)

    result = await asyncio.to_thread(run_pi, ["list"])

    assert result.code == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {"op": "list_ok", "sessions": []}


@pytest.mark.asyncio
async def test_pi_cli_list_auth_failure_reports_bounded_error(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """A mismatched secret must not be turned into an empty list or a traceback."""
    monkeypatch.setenv("INTER_AGENT_HOST", live_server.host)
    monkeypatch.setenv("INTER_AGENT_PORT", str(live_server.port))
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))

    result = await asyncio.to_thread(run_pi, ["list"])

    assert result.code == 1
    assert result.stdout == ""
    assert "Traceback" not in result.stderr
    assert "authentication failed" in result.stderr.lower()


async def test_pi_python_send_delivers_to_live_agent(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)
    async with websockets.connect(live_server.url) as target:
        await connect_agent(target, live_server, "b", "agent-b")

        result = await asyncio.to_thread(run_pi_function, pi_commands.send, "agent-b", "hello")
        delivered = await recv_json(target)

    assert result.code == 0
    assert result.stderr == ""
    assert json.loads(result.stdout)["op"] == "welcome"
    assert delivered["op"] == "msg"
    assert delivered["to"] == "agent-b"
    assert delivered["text"] == "hello"


@pytest.mark.asyncio
async def test_pi_python_broadcast_delivers_to_agents_only(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)
    async with (
        websockets.connect(live_server.url) as agent_a,
        websockets.connect(live_server.url) as agent_b,
        websockets.connect(live_server.url) as control,
    ):
        await connect_agent(agent_a, live_server, "a", "agent-a")
        await connect_agent(agent_b, live_server, "b", "agent-b")
        await connect_control(control, live_server, "ctl")

        result = await asyncio.to_thread(run_pi_function, pi_commands.broadcast, "hello all")
        delivered_a = await recv_json(agent_a)
        delivered_b = await recv_json(agent_b)
        await assert_no_message(control)

    assert result.code == 0
    assert result.stderr == ""
    assert json.loads(result.stdout)["op"] == "welcome"
    assert delivered_a["text"] == "hello all"
    assert delivered_b["text"] == "hello all"


@pytest.mark.asyncio
async def test_pi_cli_send_unknown_target_returns_protocol_error(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)

    result = await asyncio.to_thread(run_pi, ["send", "missing-agent", "hello"])

    assert result.code == 1
    assert result.stdout.strip() == ""
    assert result.stderr.splitlines() == [
        "inter-agent-pi: delivery failed (UNKNOWN_TARGET): unknown target: missing-agent",
    ]


@pytest.mark.asyncio
async def test_pi_cli_shutdown_stops_live_server(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_live_pi_defaults(monkeypatch, live_server)

    result = await asyncio.to_thread(run_pi, ["shutdown"])
    status_payload = await wait_for_pi_status_state("unavailable")

    assert result.code == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {"op": "shutdown_ok"}
    assert status_payload["state"] == "unavailable"


def test_pi_cli_shutdown_unavailable_identity_returns_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    unused_tcp_port: int,
) -> None:
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTER_AGENT_PORT", str(unused_tcp_port))

    result = run_pi(["shutdown"])

    assert result.code == 1
    assert result.stdout == ""
    assert result.stderr.startswith("inter-agent-pi: ")
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize(
    "args",
    [
        ["send", "agent-b", "hello"],
        ["broadcast", "hello"],
        ["list"],
    ],
)
def test_pi_cli_unavailable_identity_failures_use_stderr(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    unused_tcp_port: int,
    args: list[str],
) -> None:
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTER_AGENT_PORT", str(unused_tcp_port))

    result = run_pi(args)

    assert result.code == 1
    assert result.stdout == ""
    assert result.stderr.startswith("inter-agent-pi: ")
    assert "Traceback" not in result.stderr


async def wait_for_pi_channel_subscriber(channel: str, name: str) -> bool:
    deadline = asyncio.get_running_loop().time() + 5
    while asyncio.get_running_loop().time() < deadline:
        result = await asyncio.to_thread(run_pi, ["channels", "--json"])
        payload = json.loads(result.stdout)
        for entry in payload.get("channels", []):
            if entry.get("name") == channel and name in entry.get("subscribers", []):
                return True
        await asyncio.sleep(0.1)
    return False


@pytest.mark.asyncio
async def test_pi_subscribe_unsubscribe_publish_channels_round_trip(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    use_short_data_dir(monkeypatch, tmp_path_factory, live_server)
    use_live_pi_defaults(monkeypatch, live_server)

    out = io.StringIO()
    task = asyncio.create_task(
        run_listener(
            live_server.host,
            live_server.port,
            "pi-agent-a",
            None,
            output=out,
        )
    )
    try:
        # Wait until the Pi listener is connected (welcome printed).
        for _ in range(40):
            lines = [line for line in out.getvalue().splitlines() if line.strip()]
            if lines and json.loads(lines[-1]).get("op") == "welcome":
                break
            await asyncio.sleep(0.05)

        subscribe_result = await asyncio.to_thread(
            run_pi, ["subscribe", "updates", "--name", "pi-agent-a"]
        )
        assert subscribe_result.code == 0
        assert json.loads(subscribe_result.stdout) == {"op": "subscribe_ok", "channel": "updates"}

        channels_result = await asyncio.to_thread(run_pi, ["channels", "--json"])
        assert channels_result.code == 0
        payload = json.loads(channels_result.stdout)
        assert any(
            c["name"] == "updates" and "pi-agent-a" in c["subscribers"] for c in payload["channels"]
        )

        publish_result = await asyncio.to_thread(
            run_pi, ["publish", "updates", "channel hello", "--from", "pi-agent-a"]
        )
        assert publish_result.code == 0
        assert json.loads(publish_result.stdout)["op"] == "welcome"
        await asyncio.sleep(0.1)
        # The short-lived publisher uses the listener routing name, so the
        # listener suppresses its own channel delivery.
        delivered = [
            json.loads(line)
            for line in out.getvalue().splitlines()
            if line.strip() and json.loads(line).get("op") == "msg"
        ]
        assert not any(m.get("text") == "channel hello" for m in delivered)

        unsubscribe_result = await asyncio.to_thread(
            run_pi, ["unsubscribe", "updates", "--name", "pi-agent-a"]
        )
        assert unsubscribe_result.code == 0
        assert json.loads(unsubscribe_result.stdout) == {
            "op": "unsubscribe_ok",
            "channel": "updates",
        }

        empty_result = await asyncio.to_thread(run_pi, ["publish", "updates", "no one"])
        assert empty_result.code == 1
        assert "UNKNOWN_CHANNEL" in empty_result.stderr
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_pi_subscribe_without_listener_fails_cleanly(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    use_short_data_dir(monkeypatch, tmp_path_factory, live_server)
    use_live_pi_defaults(monkeypatch, live_server)

    result = await asyncio.to_thread(run_pi, ["subscribe", "updates", "--name", "missing"])

    assert result.code == 1
    assert result.stdout == ""
    assert "Traceback" not in result.stderr
    assert result.stderr.startswith("inter-agent-pi: ")


@pytest.mark.asyncio
async def test_pi_listener_reapplies_subscriptions_after_server_restart(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
    unused_tcp_port: int,
) -> None:
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))
    monkeypatch.setenv("INTER_AGENT_SECRET", "test-secret-fixed")
    monkeypatch.setenv("INTER_AGENT_HOST", "127.0.0.1")
    monkeypatch.setenv("INTER_AGENT_PORT", str(unused_tcp_port))

    server_task = asyncio.create_task(run_server("127.0.0.1", unused_tcp_port))
    await asyncio.sleep(0.1)
    out = io.StringIO()
    task = asyncio.create_task(
        run_listener("127.0.0.1", unused_tcp_port, "pi-agent-a", None, output=out)
    )
    try:
        # Wait for welcome.
        for _ in range(40):
            lines = [line for line in out.getvalue().splitlines() if line.strip()]
            if lines and json.loads(lines[-1]).get("op") == "welcome":
                break
            await asyncio.sleep(0.05)
        await asyncio.to_thread(run_pi, ["subscribe", "updates", "--name", "pi-agent-a"])

        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task
        server_task = asyncio.create_task(run_server("127.0.0.1", unused_tcp_port))
        await asyncio.sleep(0.1)
        assert await wait_for_pi_channel_subscriber("updates", "pi-agent-a")

        publish_result = await asyncio.to_thread(
            run_pi, ["publish", "updates", "post-restart", "--from", "external-publisher"]
        )
        assert publish_result.code == 0
        await asyncio.sleep(0.1)
        delivered = [
            json.loads(line)
            for line in out.getvalue().splitlines()
            if line.strip() and json.loads(line).get("op") == "msg"
        ]
        assert any(m.get("text") == "post-restart" for m in delivered)
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task


PI_EXTENSION_HARNESS = r"""const path = require("path");

const extensionPath = path.resolve(process.argv[2]);
const helperPath = process.argv[3];

const notifications = [];
const contextEntries = [];

const fakeCtx = {
  sessionManager: {
    getBranch: () => contextEntries,
  },
  ui: {
    notify: (body, type = "info") => {
      notifications.push({ body, type });
    },
    setStatus: () => {},
  },
};

const handlers = {};
const tools = {};
const eventHandlers = {};
const flags = new Map();

const fakeApi = {
  registerCommand: (name, opts) => {
    handlers[name] = opts.handler;
  },
  registerTool: (tool) => {
    tools[tool.name] = tool;
  },
  registerMessageRenderer: () => {},
  registerFlag: (name, options) => {
    flags.set(name, options);
  },
  getFlag: (name) => {
    return flags.get(name)?.default;
  },
  on: (event, fn) => {
    if (!eventHandlers[event]) eventHandlers[event] = [];
    eventHandlers[event].push(fn);
  },
  sendMessage: () => {},
  appendEntry: (type, data) => {
    contextEntries.push({ type: "custom", customType: type, data });
  },
};

const ext = require(extensionPath);
ext.default(fakeApi);

async function main() {
  process.env.INTER_AGENT_PI_HELPER = helperPath;

  for (const fn of eventHandlers["session_start"] || []) {
    await fn({}, fakeCtx);
  }

  await handlers["inter-agent"]("list", fakeCtx);
  console.log(JSON.stringify(notifications));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
"""


@pytest.mark.asyncio
async def test_pi_extension_list_command_before_connect_reports_empty_sessions(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
    tmp_path: Path,
) -> None:
    """The Pi extension /inter-agent list command works before its listener starts."""
    monkeypatch.setenv("INTER_AGENT_HOST", live_server.host)
    monkeypatch.setenv("INTER_AGENT_PORT", str(live_server.port))
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))
    monkeypatch.setenv("INTER_AGENT_SECRET", live_server.secret)

    dist_path = ROOT / "dist" / "index.js"
    src_path = ROOT / "src" / "index.ts"
    if not dist_path.exists() or dist_path.stat().st_mtime < src_path.stat().st_mtime:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)

    harness = tmp_path / "harness.js"
    harness.write_text(PI_EXTENSION_HARNESS, encoding="utf-8")
    helper = ROOT / ".venv" / "bin" / "inter-agent-pi"

    result = await asyncio.to_thread(
        subprocess.run,
        ["node", str(harness), str(dist_path), str(helper)],
        capture_output=True,
        text=True,
        check=True,
    )
    notifications = json.loads(result.stdout)
    assert notifications == [{"body": "[inter-agent] list: no agents connected", "type": "info"}]


@pytest.mark.asyncio
async def test_pi_extension_list_command_rejects_malformed_helper_response(
    live_server: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
    tmp_path: Path,
) -> None:
    """Malformed helper success output is rejected as an invalid response, not an empty list."""
    monkeypatch.setenv("INTER_AGENT_HOST", live_server.host)
    monkeypatch.setenv("INTER_AGENT_PORT", str(live_server.port))
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))
    monkeypatch.setenv("INTER_AGENT_SECRET", live_server.secret)

    dist_path = ROOT / "dist" / "index.js"
    src_path = ROOT / "src" / "index.ts"
    if not dist_path.exists() or dist_path.stat().st_mtime < src_path.stat().st_mtime:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    real_bin = ROOT / ".venv" / "bin"
    fake_pi = fake_bin / "inter-agent-pi"
    fake_pi.write_text(
        "#!/bin/bash\n"
        'if [ "$1" = "list" ] && [ "$2" = "--json" ]; then\n'
        '  echo \'{"op": "list_ok", "sessions": "not-an-array"}\'\n'
        "  exit 0\n"
        "fi\n"
        f'exec {real_bin / "inter-agent-pi"} "$@"\n',
        encoding="utf-8",
    )
    fake_pi.chmod(0o755)
    (fake_bin / "inter-agent-connect").write_bytes((real_bin / "inter-agent-connect").read_bytes())
    (fake_bin / "inter-agent-connect").chmod(0o755)
    (fake_bin / "inter-agent-server").write_bytes((real_bin / "inter-agent-server").read_bytes())
    (fake_bin / "inter-agent-server").chmod(0o755)

    harness = tmp_path / "harness.js"
    harness.write_text(PI_EXTENSION_HARNESS, encoding="utf-8")

    result = await asyncio.to_thread(
        subprocess.run,
        ["node", str(harness), str(dist_path), str(fake_pi)],
        capture_output=True,
        text=True,
        check=True,
    )
    notifications = json.loads(result.stdout)
    assert notifications == [
        {"body": "[inter-agent] list failed: invalid response", "type": "error"}
    ]
