"""Tests for the Pi listener's reconnect behavior."""

from __future__ import annotations

import asyncio
import io
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from inter_agent.core import adapter_control as control

from inter_agent_pi import listener
from inter_agent_pi.listener import (
    _PERMANENT_ERROR_CODES,
    PermanentError,
    run_listener,
)


class TestPermanentErrorCodes:
    def test_codes_match_expected_set(self) -> None:
        assert _PERMANENT_ERROR_CODES == frozenset(
            {
                "AUTH_FAILED",
                "BAD_LABEL",
                "BAD_NAME",
                "BAD_ROLE",
                "BAD_SESSION",
                "NAME_TAKEN",
                "SESSION_TAKEN",
                "TOO_MANY_CONNECTIONS",
            }
        )


class TestRunListenerReconnect:
    @pytest.mark.asyncio
    async def test_gives_up_after_deadline(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """The listener exits non-zero once the reconnect deadline is reached."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))

        # Server never available and auto-start fails.
        monkeypatch.setattr(listener, "endpoint_available", lambda host, port: False)
        monkeypatch.setattr(listener, "_start_server", lambda host, port, **kwargs: None)

        real_sleep = asyncio.sleep

        async def fast_sleep(delay: float) -> None:
            await real_sleep(0.001)

        monkeypatch.setattr(asyncio, "sleep", fast_sleep)

        # Advance the loop clock so the deadline is immediately exceeded.
        fake_time = 100.0
        loop = asyncio.get_running_loop()

        class FakeLoop:
            def time(self) -> float:
                return fake_time

        monkeypatch.setattr(loop, "time", FakeLoop().time)

        result = await run_listener(host="127.0.0.1", port=12345, name="test", deadline_s=0.0)
        assert result == 1

    @pytest.mark.asyncio
    async def test_exits_on_permanent_error(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """The listener exits immediately when the server sends a permanent error."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        monkeypatch.setattr(listener, "endpoint_available", lambda host, port: True)

        call_count = 0

        async def fake_connect_and_stream(
            host: str,
            port: int,
            name: str,
            label: str | None,
            output: io.TextIOBase,
            **kwargs: object,
        ) -> None:
            del kwargs
            nonlocal call_count
            call_count += 1
            raise PermanentError("NAME_TAKEN: name already in use")

        monkeypatch.setattr(listener, "_connect_and_stream", fake_connect_and_stream)

        result = await run_listener(host="127.0.0.1", port=12345, name="test")
        assert result == 1
        assert call_count == 1  # no retry on permanent error

    @pytest.mark.asyncio
    async def test_reconnects_after_connection_closed(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """The listener reconnects when the connection drops normally."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        monkeypatch.setattr(listener, "endpoint_available", lambda host, port: True)

        call_count = 0

        async def fake_connect_and_stream(
            host: str,
            port: int,
            name: str,
            label: str | None,
            output: io.TextIOBase,
            **kwargs: object,
        ) -> None:
            del kwargs
            nonlocal call_count
            call_count += 1
            output.write(json.dumps({"op": "welcome", "assigned_name": name}) + "\n")
            if call_count >= 3:
                raise asyncio.CancelledError()
            # Simulate a normal close — caller will reconnect.

        monkeypatch.setattr(listener, "_connect_and_stream", fake_connect_and_stream)

        real_sleep = asyncio.sleep

        async def fast_sleep(delay: float) -> None:
            await real_sleep(0.001)

        monkeypatch.setattr(asyncio, "sleep", fast_sleep)

        with pytest.raises(asyncio.CancelledError):
            await run_listener(host="127.0.0.1", port=12345, name="test")
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_auto_starts_server_when_not_running(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """The listener auto-starts the server when the endpoint is unavailable."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))

        verify_calls: list[tuple[str, int]] = []

        def fake_verify(host: str, port: int) -> bool:
            verify_calls.append((host, port))
            return len(verify_calls) > 2

        monkeypatch.setattr(listener, "endpoint_available", fake_verify)

        started: list[bool] = []

        class FakeProc:
            pid = 12345

        def fake_start_server(host: str, port: int, **kwargs: object) -> FakeProc:
            del kwargs
            started.append(True)
            return FakeProc()

        monkeypatch.setattr(listener, "_start_server", fake_start_server)

        async def fake_connect_and_stream(
            host: str,
            port: int,
            name: str,
            label: str | None,
            output: io.TextIOBase,
            **kwargs: object,
        ) -> None:
            del kwargs
            raise asyncio.CancelledError()

        monkeypatch.setattr(listener, "_connect_and_stream", fake_connect_and_stream)

        real_sleep = asyncio.sleep

        async def fast_sleep(delay: float) -> None:
            await real_sleep(0.001)

        monkeypatch.setattr(asyncio, "sleep", fast_sleep)

        with pytest.raises(asyncio.CancelledError):
            await run_listener(host="127.0.0.1", port=12345, name="test")
        assert started == [True]
        assert len(verify_calls) >= 2


class FakeSession:
    """Stand-in for AgentSession used by listener unit tests."""

    def __init__(self, frames: list[str]) -> None:
        self._frames = list(frames)
        self.subscribe_calls: list[str] = []

    async def __aenter__(self) -> FakeSession:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def _gen(self) -> AsyncIterator[str]:
        for frame in self._frames:
            yield frame

    def __aiter__(self) -> AsyncIterator[str]:
        return self._gen()

    async def subscribe(self, channel: str) -> dict[str, object]:
        self.subscribe_calls.append(channel)
        return {"op": "subscribe_ok", "channel": channel}


class TestConnectAndStream:
    @pytest.mark.asyncio
    async def test_prints_welcome_frame(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """_connect_and_stream prints the welcome frame to stdout."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        session = FakeSession([json.dumps({"op": "welcome", "assigned_name": "test"})])
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        await _connect_and_stream("127.0.0.1", 12345, "test", None, out)
        lines = out.getvalue().strip().split("\n")
        assert json.loads(lines[0])["op"] == "welcome"

    @pytest.mark.asyncio
    async def test_reapplies_desired_subscriptions_on_welcome(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A welcome re-subscribes the desired set carried across reconnects."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        frames = [
            json.dumps({"op": "welcome"}),
            json.dumps(
                {
                    "op": "msg",
                    "msg_id": "m1",
                    "channel": "updates",
                    "from_name": "x",
                    "text": "hi",
                    "ts": "t",
                }
            ),
        ]
        session = FakeSession(frames)
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )
        desired = {"updates"}

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        await _connect_and_stream("127.0.0.1", 12345, "test", None, out, desired_channels=desired)
        assert session.subscribe_calls == ["updates"]

    @pytest.mark.asyncio
    async def test_suppresses_only_own_channel_messages(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        frames = [
            json.dumps({"op": "welcome"}),
            json.dumps(
                {
                    "op": "msg",
                    "msg_id": "self-channel",
                    "channel": "updates",
                    "from_name": "test",
                    "text": "suppress me",
                }
            ),
            json.dumps(
                {
                    "op": "msg",
                    "msg_id": "self-direct",
                    "to": "test",
                    "from_name": "test",
                    "text": "keep direct",
                }
            ),
            json.dumps(
                {
                    "op": "msg",
                    "msg_id": "other-channel",
                    "channel": "updates",
                    "from_name": "other",
                    "text": "keep channel",
                }
            ),
        ]
        session = FakeSession(frames)
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )
        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        await _connect_and_stream("127.0.0.1", 12345, "test", None, out)

        output = out.getvalue()
        assert "suppress me" not in output
        assert "keep direct" in output
        assert "keep channel" in output

    @pytest.mark.asyncio
    async def test_welcome_emitted_only_after_reapply_and_control_bound(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path_factory: pytest.TempPathFactory,
    ) -> None:
        """Readiness (the raw welcome) is emitted after subscriptions are
        reapplied and the control bridge is accepting requests.

        This would fail under an implementation that prints the welcome before
        reapplying subscriptions and starting the control socket.
        """
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))
        events: list[str] = []

        class RecordingSession(FakeSession):
            async def subscribe(self, channel: str) -> dict[str, object]:
                events.append(f"reapply:{channel}")
                return await super().subscribe(channel)

        session = RecordingSession([json.dumps({"op": "welcome"})])
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        real_start = control.ControlServer.start

        async def recording_start(self_server: control.ControlServer) -> bool:
            started = await real_start(self_server)
            events.append(f"control_started:{started}")
            return started

        monkeypatch.setattr(control.ControlServer, "start", recording_start)

        def recording_print(payload: str, output: io.TextIOBase) -> None:
            events.append("printed")
            output.write(payload + "\n")
            output.flush()

        monkeypatch.setattr(listener, "_print_frame", recording_print)

        control_path = listener._control_socket_path("127.0.0.1", 12345, "test")
        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        await _connect_and_stream(
            "127.0.0.1",
            12345,
            "test",
            None,
            out,
            desired_channels={"updates"},
            control_path=control_path,
        )

        # Reapply and control bind must both precede the printed welcome.
        assert events[0] == "reapply:updates"
        assert events[1] == "control_started:True"
        assert events[2] == "printed"
        assert json.loads(out.getvalue().strip())["op"] == "welcome"

    @pytest.mark.asyncio
    async def test_raises_permanent_error_on_name_taken(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A permanent first error is emitted exactly once before raising."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        session = FakeSession(
            [json.dumps({"op": "error", "code": "NAME_TAKEN", "message": "name already in use"})]
        )
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        with pytest.raises(PermanentError, match="NAME_TAKEN"):
            await _connect_and_stream("127.0.0.1", 12345, "test", None, out)
        # The raw error frame is printed to stdout exactly once.
        lines = [line for line in out.getvalue().splitlines() if line.strip()]
        assert len(lines) == 1
        assert json.loads(lines[0]) == {
            "op": "error",
            "code": "NAME_TAKEN",
            "message": "name already in use",
        }

    @pytest.mark.asyncio
    async def test_non_permanent_first_error_emitted_before_return(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A non-permanent first error is emitted exactly once, then return."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        session = FakeSession(
            [json.dumps({"op": "error", "code": "UNKNOWN_TARGET", "message": "not found"})]
        )
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        # Must not raise: the frame is emitted and the stream ends.
        await _connect_and_stream("127.0.0.1", 12345, "test", None, out)
        lines = [line for line in out.getvalue().splitlines() if line.strip()]
        assert len(lines) == 1
        assert json.loads(lines[0])["code"] == "UNKNOWN_TARGET"


class TestControlFailurePaths:
    @pytest.mark.asyncio
    async def test_socket_chmod_failure_disables_control_and_keeps_listener_usable(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path_factory: pytest.TempPathFactory,
    ) -> None:
        """A socket chmod failure disables control without breaking the listener."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path_factory.mktemp("d")))
        session = FakeSession([json.dumps({"op": "welcome"})])
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )
        real_chmod = os.chmod

        def boom(path_obj: str | os.PathLike[str], mode: int) -> None:
            if str(path_obj).endswith(".sock"):
                raise OSError("permission denied")
            real_chmod(path_obj, mode)

        monkeypatch.setattr("inter_agent.core.adapter_control.os.chmod", boom)

        control_path = listener._control_socket_path("127.0.0.1", 12345, "test")
        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        # Must not raise: control is disabled, the welcome still prints.
        await _connect_and_stream("127.0.0.1", 12345, "test", None, out, control_path=control_path)
        assert json.loads(out.getvalue().strip())["op"] == "welcome"

    @pytest.mark.asyncio
    async def test_no_control_path_keeps_listener_usable(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        """When run_listener could not compute a control path (setup failed),
        _connect_and_stream still emits the welcome and stays usable."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        session = FakeSession([json.dumps({"op": "welcome"})])
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        await _connect_and_stream("127.0.0.1", 12345, "test", None, out, control_path=None)
        assert json.loads(out.getvalue().strip())["op"] == "welcome"

    @pytest.mark.asyncio
    async def test_run_listener_sets_control_path_none_on_dir_failure(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        """run_listener must disable control (not crash) when the control dir
        cannot be secured."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        monkeypatch.setattr(listener, "endpoint_available", lambda host, port: True)

        captured: dict[str, object] = {}

        async def fake_connect_and_stream(
            host: str,
            port: int,
            name: str,
            label: str | None,
            output: io.TextIOBase,
            *,
            desired_channels: set[str] | None = None,
            control_path: Path | None = None,
            **kwargs: object,
        ) -> None:
            del kwargs
            captured["control_path"] = control_path
            raise asyncio.CancelledError()

        monkeypatch.setattr(listener, "_connect_and_stream", fake_connect_and_stream)

        real_chmod = os.chmod

        def boom(path_obj: str | os.PathLike[str], mode: int) -> None:
            if str(path_obj).endswith("/control"):
                raise OSError("permission denied")
            real_chmod(path_obj, mode)

        monkeypatch.setattr("inter_agent.core.adapter_control.os.chmod", boom)

        real_sleep = asyncio.sleep

        async def fast_sleep(delay: float) -> None:
            await real_sleep(0.001)

        monkeypatch.setattr(asyncio, "sleep", fast_sleep)

        with pytest.raises(asyncio.CancelledError):
            await run_listener(host="127.0.0.1", port=12345, name="test")
        assert captured["control_path"] is None


class TestKickedTerminal:
    @pytest.mark.asyncio
    async def test_kicked_after_welcome_is_terminal(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A post-welcome KICKED error ends _connect_and_stream via PermanentError."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        session = FakeSession(
            [
                json.dumps({"op": "welcome", "assigned_name": "test"}),
                json.dumps({"op": "error", "code": "KICKED", "message": "removed by kick"}),
            ]
        )
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        with pytest.raises(PermanentError, match="KICKED"):
            await _connect_and_stream("127.0.0.1", 12345, "test", None, out)

    @pytest.mark.asyncio
    async def test_kicked_is_terminal_no_reconnect(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """run_listener exits non-zero on KICKED and does not reconnect."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        monkeypatch.setattr(listener, "endpoint_available", lambda host, port: True)

        call_count = 0

        async def fake_connect_and_stream(
            host: str,
            port: int,
            name: str,
            label: str | None,
            output: io.TextIOBase,
            **kwargs: object,
        ) -> None:
            del kwargs
            nonlocal call_count
            call_count += 1
            output.write(json.dumps({"op": "welcome", "assigned_name": name}) + "\n")
            raise PermanentError("KICKED: removed by kick")

        monkeypatch.setattr(listener, "_connect_and_stream", fake_connect_and_stream)

        result = await run_listener(host="127.0.0.1", port=12345, name="test")
        assert result == 1
        assert call_count == 1  # no reconnect after terminal kick

    @pytest.mark.asyncio
    async def test_non_kicked_error_after_welcome_is_not_terminal(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A non-KICKED post-welcome error is printed and does not raise."""
        monkeypatch.setenv("INTER_AGENT_DATA_DIR", str(tmp_path))
        session = FakeSession(
            [
                json.dumps({"op": "welcome"}),
                json.dumps({"op": "error", "code": "UNKNOWN_OP", "message": "bad op"}),
            ]
        )
        monkeypatch.setattr(
            "inter_agent_pi.listener.AgentSession",
            lambda *args, **kwargs: session,
        )

        out = io.StringIO()
        from inter_agent_pi.listener import _connect_and_stream

        await _connect_and_stream("127.0.0.1", 12345, "test", None, out)
        printed = [line for line in out.getvalue().splitlines() if line.strip()]
        # welcome + the non-terminal error frame are both printed.
        assert json.loads(printed[0])["op"] == "welcome"
        assert json.loads(printed[1])["code"] == "UNKNOWN_OP"
