from __future__ import annotations

import argparse
from collections.abc import Sequence

from inter_agent_pi import commands


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="inter-agent-pi")
    sub = parser.add_subparsers(dest="command", required=True)

    connect = sub.add_parser("connect")
    connect.add_argument("name")
    connect.add_argument("--label")

    send = sub.add_parser("send")
    send.add_argument("to")
    send.add_argument("text")
    send.add_argument("--from", dest="from_name")

    broadcast = sub.add_parser("broadcast")
    broadcast.add_argument("text")
    broadcast.add_argument("--from", dest="from_name")

    subscribe = sub.add_parser("subscribe")
    subscribe.add_argument("channel")
    subscribe.add_argument("--name", required=True)

    unsubscribe = sub.add_parser("unsubscribe")
    unsubscribe.add_argument("channel")
    unsubscribe.add_argument("--name", required=True)

    kick = sub.add_parser("kick")
    kick.add_argument("name")

    publish = sub.add_parser("publish")
    publish.add_argument("channel")
    publish.add_argument("text")
    publish.add_argument("--from", dest="from_name")

    channels = sub.add_parser("channels")
    channels.add_argument("--json", action="store_true", help="emit JSON protocol output")

    list_parser = sub.add_parser("list")
    list_parser.add_argument("--json", action="store_true", help="emit JSON protocol output")

    status = sub.add_parser("status")
    status.add_argument("--json", action="store_true", help="emit JSON status output")

    sub.add_parser("shutdown")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "connect":
        return commands.connect(args.name, args.label)
    if args.command == "send":
        return commands.send(args.to, args.text, args.from_name)
    if args.command == "broadcast":
        return commands.broadcast(args.text, args.from_name)
    if args.command == "subscribe":
        return commands.subscribe(args.channel, args.name)
    if args.command == "unsubscribe":
        return commands.unsubscribe(args.channel, args.name)
    if args.command == "kick":
        return commands.kick(args.name)
    if args.command == "publish":
        return commands.publish(args.channel, args.text, args.from_name)
    if args.command == "channels":
        return commands.channels(as_json=args.json)
    if args.command == "list":
        return commands.list_sessions()
    if args.command == "status":
        print(commands.status_json())
        return 0
    if args.command == "shutdown":
        return commands.shutdown()

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
