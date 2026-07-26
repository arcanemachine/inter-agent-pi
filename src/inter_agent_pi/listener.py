"""Long-running Pi listener with automatic reconnection.

The Pi extension spawns this listener as a child process. It connects to the
inter-agent bus as an agent session, prints server frames to stdout (one JSON
object per line), and reconnects with bounded backoff when the connection
drops. The server is auto-started if it is not running.

The extension reads stdout frames: ``welcome`` marks the listener ready,
``msg`` frames are delivered as notifications, and ``error`` frames indicate
permanent connection rejections.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import socket
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO

import websockets
from inter_agent.core import adapter_control as control
from inter_agent.core.client import AgentSession
from inter_agent.core.shared import DEFAULT_HOST, DEFAULT_PORT, resolve_endpoint

RECONNECT_BACKOFF_MIN_S = 0.5
RECONNECT_BACKOFF_MAX_S = 4.0
RECONNECT_JITTER_FRAC = 0.2
RECONNECT_DEADLINE_S = 60.0
AUTO_STARTED_SERVER_IDLE_TIMEOUT_S = 300

# Terminal kick signal: a post-welcome KICKED error ends this listener process
# without reconnecting. It is intentionally not part of _PERMANENT_ERROR_CODES
# (which classify the first welcome-time frame); KICKED arrives after welcome.
KICKED_ERROR_CODE = "KICKED"

# Server error codes that won't resolve by reconnecting.
_PERMANENT_ERROR_CODES = frozenset(
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

log = logging.getLogger("inter-agent.pi.listener")


def pi_data_dir() -> Path:
    """Return the Pi adapter data directory under the core data dir."""
    from inter_agent.core.shared import data_dir as core_data_dir

    path = core_data_dir() / "pi-sessions"
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def _control_socket_path(host: str, port: int, name: str) -> Path:
    return control.control_socket_path("pi", host, port, name, pi_data_dir())


class PermanentError(Exception):
    """Raised when the server returns an error that reconnecting cannot resolve."""


def endpoint_available(host: str, port: int) -> bool:
    """Return True when the configured TCP endpoint accepts connections."""
    try:
        with socket.create_connection((host, port), timeout=0.2):
            return True
    except OSError:
        return False


def _print_frame(payload: str, output: TextIO) -> None:
    """Emit a single JSON frame to stdout, flushed."""
    output.write(payload + "\n")
    output.flush()


def _start_server(
    host: str,
    port: int,
    *,
    tls: bool = False,
    tls_cert_path: str | None = None,
    tls_key_path: str | None = None,
) -> subprocess.Popen[bytes] | None:
    """Start inter-agent-server as a child process with an explicit idle timeout."""
    try:
        args = [
            sys.executable,
            "-m",
            "inter_agent.core.server",
            "--host",
            host,
            "--port",
            str(port),
            "--idle-timeout",
            str(AUTO_STARTED_SERVER_IDLE_TIMEOUT_S),
        ]
        if tls:
            args.append("--tls")
        else:
            args.append("--no-tls")
        if tls_cert_path:
            args.extend(["--tls-cert", tls_cert_path])
        if tls_key_path:
            args.extend(["--tls-key", tls_key_path])
        return subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return None


async def _connect_and_stream(
    host: str,
    port: int,
    name: str,
    label: str | None,
    output: TextIO,
    *,
    tls: bool = False,
    data_dir: Path | None = None,
    tls_cert_path: Path | None = None,
    desired_channels: set[str] | None = None,
    control_path: Path | None = None,
) -> None:
    """Connect once, print raw frames, and return when the connection closes.

    Reapplies the desired subscription set after a welcome so a transient
    reconnect does not drop subscriptions. Raises PermanentError if the server
    rejects the connection with a permanent error code as the first frame.
    """
    desired = desired_channels

    async with AgentSession(
        host, port, name, label, tls=tls, data_dir=data_dir, tls_cert_path=tls_cert_path
    ) as session:
        control_server: control.ControlServer | None = None

        async def handle_request(op: str, channel: str) -> dict[str, object]:
            try:
                if op == "subscribe":
                    response = await session.subscribe(channel)
                    if response.get("op") == "subscribe_ok" and desired is not None:
                        desired.add(channel)
                    return response
                response = await session.unsubscribe(channel)
                if response.get("op") == "unsubscribe_ok" and desired is not None:
                    desired.discard(channel)
                return response
            except Exception as exc:
                return {"op": "error", "code": "LISTENER_UNAVAILABLE", "message": str(exc)}

        async def reapply_desired() -> None:
            for channel in sorted(desired or ()):
                try:
                    await session.subscribe(channel)
                except Exception:
                    pass

        async def bind_control() -> None:
            # (Re)bind the local control socket. Failures fail closed: the
            # listener stays usable and the extension is told control is
            # unavailable rather than rediscovering the connection down.
            nonlocal control_server
            if control_server is not None:
                await control_server.stop()
                control_server = None
            if control_path is None:
                return
            try:
                server = control.ControlServer(control_path, handle_request)
                started = await server.start()
                if not started:
                    log.warning("control socket unavailable; subscribe/unsubscribe disabled")
                    await server.stop()
                    return
                control_server = server
            except OSError as exc:
                log.warning("control socket setup failed: %s", exc)

        try:
            first = True
            async for raw in session:
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = None
                op = payload.get("op") if payload is not None else None

                if op == "welcome":
                    # Reapply subscriptions and bind the control socket BEFORE
                    # emitting the welcome so the host cannot mark the listener
                    # ready before channels are restored and the bridge is
                    # accepting requests.
                    await reapply_desired()
                    await bind_control()
                    _print_frame(raw, output)
                    first = False
                    continue

                if first:
                    # The initial frame is part of readiness: emit it exactly
                    # once before acting on it so the host sees the raw error.
                    _print_frame(raw, output)
                    first = False
                    if op == "error":
                        code = payload.get("code", "") if payload is not None else ""
                        if isinstance(code, str) and code in _PERMANENT_ERROR_CODES:
                            raise PermanentError(f"{code}: {payload.get('message', '')}")
                        return
                    continue
                if (
                    op == "error"
                    and payload is not None
                    and payload.get("code") == KICKED_ERROR_CODE
                ):
                    # Terminal kick: stop reconnecting for this listener process.
                    # The routing name stays free for an explicit later reconnect.
                    raise PermanentError(f"{KICKED_ERROR_CODE}: {payload.get('message', '')}")
                if (
                    op == "msg"
                    and isinstance(payload.get("channel"), str)
                    and payload.get("from_name") == name
                ):
                    continue
                _print_frame(raw, output)
        finally:
            if control_server is not None:
                await control_server.stop()
                control_server = None


def _jittered_delay(backoff: float) -> float:
    jitter = backoff * RECONNECT_JITTER_FRAC
    return max(0.0, backoff + random.uniform(-jitter, jitter))


async def run_listener(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    name: str = "",
    label: str | None = None,
    output: TextIO | None = None,
    deadline_s: float = RECONNECT_DEADLINE_S,
    *,
    tls: bool = False,
    data_dir: Path | None = None,
    tls_cert_path: Path | None = None,
    tls_key_path: Path | None = None,
) -> int:
    """Run the listener with automatic reconnection and eventual give-up.

    Reconnects with bounded backoff while the connection is down. Gives up if
    a reconnection would land at or past ``deadline_s`` seconds from the first
    failure. Each successful connection resets the deadline, so a flapping
    server that connects intermittently does not give up.

    Returns 0 on clean shutdown, 1 on permanent error or give-up.
    """
    stream = output or sys.stdout
    desired_channels: set[str] = set()
    try:
        control_path: Path | None = _control_socket_path(host, port, name)
    except OSError:
        log.warning("control socket unavailable; subscribe/unsubscribe disabled")
        control_path = None
    backoff = RECONNECT_BACKOFF_MIN_S
    deadline: float | None = None
    server_started = False

    while True:
        # Ensure the server is running, auto-starting if needed.
        if not endpoint_available(host, port):
            if not server_started:
                proc = _start_server(
                    host,
                    port,
                    tls=tls,
                    tls_cert_path=str(tls_cert_path) if tls_cert_path is not None else None,
                    tls_key_path=str(tls_key_path) if tls_key_path is not None else None,
                )
                if proc is None:
                    print(
                        "[inter-agent] failed to auto-start server; giving up",
                        file=sys.stderr,
                    )
                    return 1
                server_started = True
                log.info("auto-started server pid %s", proc.pid)
            # Wait for the server to come up.
            ready = False
            for _ in range(30):
                if endpoint_available(host, port):
                    ready = True
                    break
                await asyncio.sleep(0.5)
            if not ready:
                if deadline is None:
                    deadline = asyncio.get_running_loop().time() + deadline_s
                if asyncio.get_running_loop().time() >= deadline:
                    print(
                        "[inter-agent] server did not become available; giving up",
                        file=sys.stderr,
                    )
                    return 1
                await asyncio.sleep(_jittered_delay(backoff))
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX_S)
                continue

        try:
            await _connect_and_stream(
                host,
                port,
                name,
                label,
                stream,
                tls=tls,
                data_dir=data_dir,
                tls_cert_path=tls_cert_path,
                desired_channels=desired_channels,
                control_path=control_path,
            )
            # Connection closed normally — reset and reconnect.
            backoff = RECONNECT_BACKOFF_MIN_S
            deadline = None
        except PermanentError:
            return 1
        except (ConnectionRefusedError, OSError, websockets.ConnectionClosed):
            pass

        if deadline is None:
            deadline = asyncio.get_running_loop().time() + deadline_s
        if asyncio.get_running_loop().time() >= deadline:
            print(
                f"[inter-agent] giving up; could not reconnect within {deadline_s:.0f}s",
                file=sys.stderr,
            )
            return 1

        await asyncio.sleep(_jittered_delay(backoff))
        backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX_S)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="inter-agent-pi connect")
    parser.add_argument("name", nargs="?")
    parser.add_argument("--name", dest="name_option")
    parser.add_argument("--label")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--tls", dest="tls", action="store_true", default=None)
    parser.add_argument("--no-tls", dest="tls", action="store_false")
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    name = args.name_option or args.name
    if not name:
        parser.error("name is required")
    endpoint = resolve_endpoint(
        args.host,
        args.port,
        allow_discovery=True,
        tls=args.tls,
        tls_cert_path=args.tls_cert,
        tls_key_path=args.tls_key,
    )
    return asyncio.run(
        run_listener(
            endpoint.host,
            endpoint.port,
            name,
            args.label,
            tls=endpoint.tls,
            data_dir=endpoint.data_dir,
            tls_cert_path=endpoint.tls_cert_path,
            tls_key_path=endpoint.tls_key_path,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
