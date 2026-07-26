from __future__ import annotations

import json
from pathlib import Path

import inter_agent.core.adapter_control as control
import inter_agent.core.channels as core_channels
import inter_agent.core.kick as core_kick
import inter_agent.core.list as core_list
import inter_agent.core.publish as core_publish
import inter_agent.core.send as core_send
import inter_agent.core.shutdown as core_shutdown
import pytest
from inter_agent.core.channels import ChannelsResult
from inter_agent.core.kick import KickResult
from inter_agent.core.list import ListResult, SessionInfo
from inter_agent.core.send import ProtocolErrorResult, SendResult
from inter_agent.core.shutdown import ShutdownResult

from inter_agent_pi import commands, listener
from inter_agent_pi.cli import main


def test_status_outputs_json(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    unused_tcp_port: int,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTER_AGENT_PORT", str(unused_tcp_port))

    code = main(["status", "--json"])

    assert code == 0
    assert json.loads(capsys.readouterr().out) == {
        "state": "unavailable",
        "host": "127.0.0.1",
        "port": unused_tcp_port,
        "configured_host": "127.0.0.1",
        "configured_port": unused_tcp_port,
        "scheme": "ws",
        "tls": False,
        "tls_source": "default",
        "tls_cert_path": None,
        "tls_cert_source": None,
        "host_source": "default",
        "port_source": "env",
        "data_dir": str(tmp_path),
        "data_dir_source": "env",
        "config_path": None,
        "hints": ["start inter-agent-server or check INTER_AGENT_HOST and INTER_AGENT_PORT"],
        "server_reachable": False,
        "message": "server connection failed",
        "core_list_supported": True,
        "adapter_list_exposed": True,
    }


def test_send_uses_core_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int, str, str, str | None]] = []

    async def fake_send(
        host: str,
        port: int,
        to: str,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        calls.append((host, port, to, text, from_name))
        return SendResult(welcome='{"op": "welcome"}', welcome_payload={"op": "welcome"})

    monkeypatch.setattr(core_send, "send_direct_message", fake_send)

    code = commands.send("agent-b", "hello", "agent-a")

    assert code == 0
    assert calls == [("127.0.0.1", 16837, "agent-b", "hello", "agent-a")]
    assert capsys.readouterr().out == '{"op": "welcome"}\n'


def test_send_cli_accepts_from_name(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int, str, str, str | None]] = []

    async def fake_send(
        host: str,
        port: int,
        to: str,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        calls.append((host, port, to, text, from_name))
        return SendResult(welcome='{"op": "welcome"}', welcome_payload={"op": "welcome"})

    monkeypatch.setattr(core_send, "send_direct_message", fake_send)

    assert main(["send", "agent-b", "hello", "--from", "agent-a"]) == 0

    assert calls == [("127.0.0.1", 16837, "agent-b", "hello", "agent-a")]
    assert capsys.readouterr().out == '{"op": "welcome"}\n'


def test_send_protocol_error_returns_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_send(
        host: str,
        port: int,
        to: str,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        del from_name
        return SendResult(
            welcome='{"op": "welcome"}',
            welcome_payload={"op": "welcome"},
            error=ProtocolErrorResult(
                code="UNKNOWN_TARGET",
                message="unknown target: missing",
                raw=(
                    '{"op": "error", "code": "UNKNOWN_TARGET", '
                    '"message": "unknown target: missing"}'
                ),
            ),
        )

    monkeypatch.setattr(core_send, "send_direct_message", fake_send)

    code = commands.send("missing", "hello")

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "inter-agent-pi: delivery failed (UNKNOWN_TARGET): unknown target: missing",
    ]


def test_broadcast_uses_core_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int, str, str | None]] = []

    async def fake_broadcast(
        host: str,
        port: int,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        calls.append((host, port, text, from_name))
        return SendResult(welcome='{"op": "welcome"}', welcome_payload={"op": "welcome"})

    monkeypatch.setattr(core_send, "broadcast_message", fake_broadcast)

    code = commands.broadcast("hello all", "agent-a")

    assert code == 0
    assert calls == [("127.0.0.1", 16837, "hello all", "agent-a")]
    assert capsys.readouterr().out == '{"op": "welcome"}\n'


def test_broadcast_cli_accepts_from_name(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int, str, str | None]] = []

    async def fake_broadcast(
        host: str,
        port: int,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        calls.append((host, port, text, from_name))
        return SendResult(welcome='{"op": "welcome"}', welcome_payload={"op": "welcome"})

    monkeypatch.setattr(core_send, "broadcast_message", fake_broadcast)

    assert main(["broadcast", "hello all", "--from", "agent-a"]) == 0

    assert calls == [("127.0.0.1", 16837, "hello all", "agent-a")]
    assert capsys.readouterr().out == '{"op": "welcome"}\n'


def test_list_uses_core_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int]] = []

    async def fake_list(host: str, port: int, **kwargs: object) -> ListResult:
        del kwargs
        calls.append((host, port))
        return ListResult(
            raw_response='{"op": "list_ok", "sessions": []}',
            response={"op": "list_ok", "sessions": []},
            sessions=(),
        )

    monkeypatch.setattr(core_list, "list_sessions", fake_list)

    code = commands.list_sessions()

    assert code == 0
    assert calls == [("127.0.0.1", 16837)]
    assert capsys.readouterr().out == '{"op": "list_ok", "sessions": []}\n'


def test_list_cli_reports_populated_sessions(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_list(host: str, port: int, **kwargs: object) -> ListResult:
        del kwargs
        return ListResult(
            raw_response=(
                '{"op": "list_ok", "sessions": [{'
                '"session_id": "a", "name": "agent-a", "label": "Agent A"}]}'
            ),
            response={
                "op": "list_ok",
                "sessions": [{"session_id": "a", "name": "agent-a", "label": "Agent A"}],
            },
            sessions=(SessionInfo(session_id="a", name="agent-a", label="Agent A"),),
        )

    monkeypatch.setattr(core_list, "list_sessions", fake_list)

    code = commands.list_sessions()

    assert code == 0
    assert json.loads(capsys.readouterr().out) == {
        "op": "list_ok",
        "sessions": [{"session_id": "a", "name": "agent-a", "label": "Agent A"}],
    }


def test_list_cli_preserves_malformed_success_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI prints the raw helper response; the Pi extension validates shape."""

    async def fake_list(host: str, port: int, **kwargs: object) -> ListResult:
        del kwargs
        return ListResult(
            raw_response='{"op": "list_ok", "sessions": "not-an-array"}',
            response={"op": "list_ok", "sessions": "not-an-array"},
            sessions=(),
        )

    monkeypatch.setattr(core_list, "list_sessions", fake_list)

    code = commands.list_sessions()

    assert code == 0
    assert json.loads(capsys.readouterr().out) == {
        "op": "list_ok",
        "sessions": "not-an-array",
    }


def test_shutdown_uses_core_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int]] = []

    async def fake_shutdown(host: str, port: int, **kwargs: object) -> ShutdownResult:
        del kwargs
        calls.append((host, port))
        return ShutdownResult(
            response='{"op": "shutdown_ok"}',
            response_payload={"op": "shutdown_ok"},
        )

    monkeypatch.setattr(core_shutdown, "shutdown_server", fake_shutdown)

    code = commands.shutdown()

    assert code == 0
    assert calls == [("127.0.0.1", 16837)]
    assert capsys.readouterr().out == '{"op": "shutdown_ok"}\n'


def test_connect_uses_listener(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, int, str, str | None]] = []

    async def fake_run_listener(
        host: str, port: int, name: str, label: str | None = None, **kwargs: object
    ) -> int:
        calls.append((host, port, name, label))
        return 0

    monkeypatch.setattr(listener, "run_listener", fake_run_listener)

    code = commands.connect("agent-a", "Agent A")

    assert code == 0
    assert calls == [("127.0.0.1", 16837, "agent-a", "Agent A")]


def test_subscribe_invokes_control_bridge(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, str, int, str, str, str, str]] = []

    async def fake_request(
        adapter: str, host: str, port: int, name: str, base_dir: object, op: str, channel: str
    ) -> dict[str, object]:
        calls.append((adapter, host, port, name, str(base_dir), op, channel))
        return {"op": "subscribe_ok", "channel": channel}

    monkeypatch.setattr(control, "request", fake_request)

    code = main(["subscribe", "updates", "--name", "agent-a"])

    assert code == 0
    assert calls == [
        ("pi", "127.0.0.1", 16837, "agent-a", str(listener.pi_data_dir()), "subscribe", "updates")
    ]
    assert json.loads(capsys.readouterr().out) == {"op": "subscribe_ok", "channel": "updates"}


def test_unsubscribe_invokes_control_bridge(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_request(
        adapter: str, host: str, port: int, name: str, base_dir: object, op: str, channel: str
    ) -> dict[str, object]:
        return {"op": "unsubscribe_ok", "channel": channel}

    monkeypatch.setattr(control, "request", fake_request)

    code = main(["unsubscribe", "updates", "--name", "agent-a"])

    assert code == 0
    assert json.loads(capsys.readouterr().out) == {"op": "unsubscribe_ok", "channel": "updates"}


def test_subscribe_protocol_error_returns_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_request(
        adapter: str, host: str, port: int, name: str, base_dir: object, op: str, channel: str
    ) -> dict[str, object]:
        return {"op": "error", "code": "CHANNEL_LIMIT_REACHED", "message": "limit reached"}

    monkeypatch.setattr(control, "request", fake_request)

    code = main(["subscribe", "updates", "--name", "agent-a"])

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "inter-agent-pi: (CHANNEL_LIMIT_REACHED): limit reached",
    ]


def test_subscribe_missing_listener_reports_cleanly(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise control.ControlError("not connected; start the listener first")

    monkeypatch.setattr(control, "request", fake_request)

    code = commands.subscribe("updates", "agent-a")

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err
    assert captured.err.startswith("inter-agent-pi: ")


def test_subscribe_invalid_channel_returns_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise AssertionError("control.request must not be called")

    monkeypatch.setattr(control, "request", fake_request)

    code = commands.subscribe("Bad Channel!", "agent-a")

    assert code == 1
    assert "invalid channel name" in capsys.readouterr().err


def test_publish_delegates_to_core_and_accepts_from_name(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int, str, str, str | None]] = []

    async def fake_publish(
        host: str,
        port: int,
        channel: str,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        calls.append((host, port, channel, text, from_name))
        return SendResult(welcome='{"op": "welcome"}', welcome_payload={"op": "welcome"})

    monkeypatch.setattr(core_publish, "publish_to_channel", fake_publish)

    code = main(["publish", "updates", "hello", "--from", "agent-a"])

    assert code == 0
    assert calls == [("127.0.0.1", 16837, "updates", "hello", "agent-a")]
    # Pi publish success prints the welcome envelope.
    assert capsys.readouterr().out == '{"op": "welcome"}\n'


def test_publish_protocol_error_returns_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_publish(
        host: str,
        port: int,
        channel: str,
        text: str,
        from_name: str | None = None,
        **kwargs: object,
    ) -> SendResult:
        del kwargs
        return SendResult(
            welcome='{"op": "welcome"}',
            welcome_payload={"op": "welcome"},
            error=ProtocolErrorResult(
                code="UNKNOWN_CHANNEL",
                message="unknown channel",
                raw='{"op": "error", "code": "UNKNOWN_CHANNEL", "message": "unknown channel"}',
            ),
        )

    monkeypatch.setattr(core_publish, "publish_to_channel", fake_publish)

    code = commands.publish("updates", "hello")

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "inter-agent-pi: publish failed (UNKNOWN_CHANNEL): unknown channel",
    ]


def test_channels_uses_core_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int]] = []

    async def fake_channels(host: str, port: int, **kwargs: object) -> ChannelsResult:
        del kwargs
        calls.append((host, port))
        return ChannelsResult(
            raw_response='{"op": "channels_ok", "channels": []}',
            response={"op": "channels_ok", "channels": []},
            channels=(),
        )

    monkeypatch.setattr(core_channels, "list_channels", fake_channels)

    code = commands.channels()

    assert code == 0
    assert calls == [("127.0.0.1", 16837)]
    assert json.loads(capsys.readouterr().out) == {"op": "channels_ok", "channels": []}


def test_subscribe_config_failure_is_adapter_prefixed_and_traceback_free(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """resolve_endpoint config failures stay adapter-prefixed and traceback-free."""
    monkeypatch.setenv("INTER_AGENT_PORT", "not-an-int")

    async def fake_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise AssertionError("control.request must not be called for a config failure")

    monkeypatch.setattr(control, "request", fake_request)

    code = main(["subscribe", "updates", "--name", "agent-a"])

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err
    assert captured.err.startswith("inter-agent-pi: ")
    assert "INTER_AGENT_PORT" in captured.err


def test_unsubscribe_config_failure_is_adapter_prefixed_and_traceback_free(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("INTER_AGENT_PORT", "not-an-int")

    async def fake_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise AssertionError("control.request must not be called for a config failure")

    monkeypatch.setattr(control, "request", fake_request)

    code = main(["unsubscribe", "updates", "--name", "agent-a"])

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err
    assert captured.err.startswith("inter-agent-pi: ")


def test_subscribe_data_dir_oserror_is_adapter_prefixed_and_traceback_free(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """An OSError from the data-dir lookup is adapter-prefixed and clean."""

    async def fake_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise AssertionError("control.request must not be called for a data-dir failure")

    monkeypatch.setattr(control, "request", fake_request)

    def boom() -> Path:
        raise OSError("disk full")

    monkeypatch.setattr(listener, "pi_data_dir", boom)

    code = main(["subscribe", "updates", "--name", "agent-a"])

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err
    assert captured.err.startswith("inter-agent-pi: ")
    assert "disk full" in captured.err


def test_unsubscribe_data_dir_oserror_is_adapter_prefixed_and_traceback_free(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise AssertionError("control.request must not be called for a data-dir failure")

    monkeypatch.setattr(control, "request", fake_request)

    def boom() -> Path:
        raise OSError("disk full")

    monkeypatch.setattr(listener, "pi_data_dir", boom)

    code = main(["unsubscribe", "updates", "--name", "agent-a"])

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err
    assert captured.err.startswith("inter-agent-pi: ")
    assert "disk full" in captured.err


def test_kick_uses_core_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, int, str | None, str | None]] = []

    async def fake_kick(
        host: str,
        port: int,
        *,
        name: str | None = None,
        session_id: str | None = None,
        **kwargs: object,
    ) -> KickResult:
        del kwargs
        calls.append((host, port, name, session_id))
        return KickResult(
            response='{"op": "kick_ok", "name": "agent-b", "session_id": "b"}',
            response_payload={"op": "kick_ok", "name": "agent-b", "session_id": "b"},
        )

    monkeypatch.setattr(core_kick, "kick_session", fake_kick)

    code = commands.kick("agent-b")

    assert code == 0
    assert calls == [("127.0.0.1", 16837, "agent-b", None)]
    assert json.loads(capsys.readouterr().out) == {
        "op": "kick_ok",
        "name": "agent-b",
        "session_id": "b",
    }


def test_kick_cli_dispatches_to_command(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_kick(
        host: str,
        port: int,
        *,
        name: str | None = None,
        session_id: str | None = None,
        **kwargs: object,
    ) -> KickResult:
        del kwargs
        return KickResult(
            response='{"op": "kick_ok", "name": "agent-b", "session_id": "b"}',
            response_payload={"op": "kick_ok", "name": "agent-b", "session_id": "b"},
        )

    monkeypatch.setattr(core_kick, "kick_session", fake_kick)

    assert main(["kick", "agent-b"]) == 0
    assert json.loads(capsys.readouterr().out)["op"] == "kick_ok"


def test_kick_protocol_error_returns_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_kick(
        host: str,
        port: int,
        *,
        name: str | None = None,
        session_id: str | None = None,
        **kwargs: object,
    ) -> KickResult:
        del kwargs, name, session_id
        return KickResult(
            response='{"op": "error", "code": "UNKNOWN_TARGET", "message": "unknown target"}',
            response_payload={
                "op": "error",
                "code": "UNKNOWN_TARGET",
                "message": "unknown target",
            },
        )

    monkeypatch.setattr(core_kick, "kick_session", fake_kick)

    code = commands.kick("ghost")

    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "inter-agent-pi: (UNKNOWN_TARGET): unknown target",
    ]


def test_kick_does_not_require_listener(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """kick uses a short-lived control connection and must not start a listener
    or touch the control bridge."""

    async def fake_kick(
        host: str,
        port: int,
        *,
        name: str | None = None,
        session_id: str | None = None,
        **kwargs: object,
    ) -> KickResult:
        del kwargs
        return KickResult(
            response='{"op": "kick_ok", "name": "x", "session_id": "x"}',
            response_payload={"op": "kick_ok", "name": "x", "session_id": "x"},
        )

    monkeypatch.setattr(core_kick, "kick_session", fake_kick)

    async def fail_listener(*args: object, **kwargs: object) -> int:
        raise AssertionError("kick must not start the listener")

    async def fail_request(*args: object, **kwargs: object) -> dict[str, object]:
        raise AssertionError("kick must not use the control bridge")

    monkeypatch.setattr(listener, "run_listener", fail_listener)
    monkeypatch.setattr(control, "request", fail_request)

    assert commands.kick("x") == 0
    assert json.loads(capsys.readouterr().out)["op"] == "kick_ok"
