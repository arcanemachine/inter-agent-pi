"""Pi adapter wrappers around importable core command APIs.

Core supports `list`; adapter surfaces may choose whether to expose it.
"""

from __future__ import annotations

import asyncio
import json
import sys

from inter_agent.core import adapter_control as control
from inter_agent.core import channels as core_channels
from inter_agent.core import kick as core_kick
from inter_agent.core import list as core_list
from inter_agent.core import publish as core_publish
from inter_agent.core import send as core_send
from inter_agent.core import shutdown as core_shutdown
from inter_agent.core import status as core_status
from inter_agent.core.send import SendResult
from inter_agent.core.shared import Limits, resolve_endpoint, validate_channel_name
from websockets.exceptions import WebSocketException

from inter_agent_pi import listener


def _system_exit_code(exc: SystemExit) -> int:
    if isinstance(exc.code, int):
        return exc.code
    if exc.code is not None:
        print(exc.code, file=sys.stderr)
    return 1


def _expected_error_code(exc: Exception) -> int:
    print(f"inter-agent-pi: {exc}", file=sys.stderr)
    return 1


def _send_result_code(result: SendResult) -> int:
    if result.error is not None:
        print(
            f"inter-agent-pi: delivery failed ({result.error.code}): {result.error.message}",
            file=sys.stderr,
        )
        return 1
    print(result.welcome)
    return 0


def connect(name: str, label: str | None = None) -> int:
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        return asyncio.run(
            listener.run_listener(
                endpoint.host,
                endpoint.port,
                name,
                label,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
                tls_key_path=endpoint.tls_key_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)


def send(to: str, text: str, from_name: str | None = None) -> int:
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_send.send_direct_message(
                endpoint.host,
                endpoint.port,
                to,
                text,
                from_name,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    return _send_result_code(result)


def broadcast(text: str, from_name: str | None = None) -> int:
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_send.broadcast_message(
                endpoint.host,
                endpoint.port,
                text,
                from_name,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    return _send_result_code(result)


def _control_response_code(response: dict[str, object]) -> int:
    op = response.get("op")
    if op in ("subscribe_ok", "unsubscribe_ok"):
        print(json.dumps(response, ensure_ascii=False))
        return 0
    if op == "error":
        code = response.get("code", "PROTOCOL_ERROR")
        message = response.get("message", "protocol error")
        print(f"inter-agent-pi: ({code}): {message}", file=sys.stderr)
        return 1
    print(f"inter-agent-pi: unexpected response: {response}", file=sys.stderr)
    return 1


def _validate_channel_or_error(channel: str) -> bool:
    if not validate_channel_name(channel, Limits().channel_name_max):
        print(f"inter-agent-pi: invalid channel name: {channel!r}", file=sys.stderr)
        return False
    return True


def subscribe(channel: str, name: str) -> int:
    """Subscribe the named live listener to a channel."""
    if not _validate_channel_or_error(channel):
        return 1
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        response = asyncio.run(
            control.request(
                "pi",
                endpoint.host,
                endpoint.port,
                name,
                listener.pi_data_dir(),
                "subscribe",
                channel,
            )
        )
    except (
        SystemExit,
        control.ControlError,
        OSError,
        TimeoutError,
        ValueError,
        WebSocketException,
    ) as exc:
        print(f"inter-agent-pi: {exc}", file=sys.stderr)
        return 1
    return _control_response_code(response)


def unsubscribe(channel: str, name: str) -> int:
    """Unsubscribe the named live listener from a channel."""
    if not _validate_channel_or_error(channel):
        return 1
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        response = asyncio.run(
            control.request(
                "pi",
                endpoint.host,
                endpoint.port,
                name,
                listener.pi_data_dir(),
                "unsubscribe",
                channel,
            )
        )
    except (
        SystemExit,
        control.ControlError,
        OSError,
        TimeoutError,
        ValueError,
        WebSocketException,
    ) as exc:
        print(f"inter-agent-pi: {exc}", file=sys.stderr)
        return 1
    return _control_response_code(response)


def publish(channel: str, text: str, from_name: str | None = None) -> int:
    if not _validate_channel_or_error(channel):
        return 1
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_publish.publish_to_channel(
                endpoint.host,
                endpoint.port,
                channel,
                text,
                from_name,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    # Pi publish success prints the welcome envelope, matching send/broadcast.
    if result.error is not None:
        print(
            f"inter-agent-pi: publish failed ({result.error.code}): {result.error.message}",
            file=sys.stderr,
        )
        return 1
    print(result.welcome)
    return 0


def channels(as_json: bool = True) -> int:
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_channels.list_channels(
                endpoint.host,
                endpoint.port,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    print(result.raw_response)
    return 0 if result.response.get("op") == "channels_ok" else 1


def list_sessions() -> int:
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_list.list_sessions(
                endpoint.host,
                endpoint.port,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    print(result.raw_response)
    return 0


def kick(name: str) -> int:
    """Force-disconnect a named agent role session through a control connection.

    User-only: the host command surface invokes this; no model-callable tool
    wraps it. It does not require the local Pi listener to be connected.
    """
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_kick.kick_session(
                endpoint.host,
                endpoint.port,
                name=name,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    if result.response_payload.get("op") == "kick_ok":
        print(result.response)
        return 0
    code = result.response_payload.get("code", "PROTOCOL_ERROR")
    message = result.response_payload.get("message", "kick failed")
    print(f"inter-agent-pi: ({code}): {message}", file=sys.stderr)
    return 1


def shutdown() -> int:
    try:
        endpoint = resolve_endpoint(allow_discovery=True)
        result = asyncio.run(
            core_shutdown.shutdown_server(
                endpoint.host,
                endpoint.port,
                tls=endpoint.tls,
                data_dir=endpoint.data_dir,
                tls_cert_path=endpoint.tls_cert_path,
            )
        )
    except SystemExit as exc:
        return _system_exit_code(exc)
    except (OSError, TimeoutError, ValueError, WebSocketException) as exc:
        return _expected_error_code(exc)
    print(result.response)
    return 0 if result.response_payload.get("op") == "shutdown_ok" else 1


def status() -> dict[str, object]:
    command = core_status.command_status()
    endpoint = resolve_endpoint(allow_discovery=True)
    server = asyncio.run(core_status.check_resolved_server_status(endpoint))
    return {
        "state": server.state,
        "host": server.host,
        "port": server.port,
        "configured_host": server.configured_host,
        "configured_port": server.configured_port,
        "scheme": server.scheme,
        "tls": server.tls,
        "tls_source": server.tls_source,
        "tls_cert_path": server.tls_cert_path,
        "tls_cert_source": server.tls_cert_source,
        "host_source": server.host_source,
        "port_source": server.port_source,
        "data_dir": server.data_dir,
        "data_dir_source": server.data_dir_source,
        "config_path": server.config_path,
        "hints": list(server.hints),
        "server_reachable": server.reachable,
        "message": server.message,
        "core_list_supported": command.list_supported,
        "adapter_list_exposed": True,
    }


def status_json() -> str:
    return json.dumps(status())
