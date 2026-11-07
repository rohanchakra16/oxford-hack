"""Command line: ``oxford-backend serve`` and ``oxford-backend replay``."""

from __future__ import annotations

import argparse
import ipaddress
import os
import secrets
import stat
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TOKEN_FILE = REPO_ROOT / ".local" / "launch-token"


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_launch_token(path: Path, *, rotate: bool = False) -> str:
    """Per-install launch token, persisted with 0600 permissions so it survives backend restarts."""
    env = os.environ.get("OXFORD_LAUNCH_TOKEN")
    if env:
        if len(env) < 16:
            raise SystemExit("OXFORD_LAUNCH_TOKEN must be at least 16 characters")
        return env
    if path.exists() and not rotate:
        token = path.read_text().strip()
        if len(token) >= 16:
            return token
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return token


def serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .contracts.messages import MAX_MESSAGE_BYTES
    from .harness.synthetic import simulation_factory
    from .session.hub import Hub, HubSettings
    from .transport.app import ServerConfig, create_app

    if not _is_loopback(args.host):
        print(
            f"refusing to bind to non-loopback host {args.host!r}: this service is local-only",
            file=sys.stderr,
        )
        return 2
    token = load_launch_token(Path(args.launch_token_file), rotate=args.rotate_launch_token)
    origins = args.allowed_origin or ["http://localhost:5173", "http://127.0.0.1:5173"]
    config = ServerConfig(launch_token=token, allowed_origins=origins, test_hooks=args.enable_test_hooks)
    run_kinds = frozenset({"live", "simulated"} if args.allow_simulated else {"live"})
    settings = HubSettings(allowed_run_kinds=run_kinds)

    def hub_factory(clock):  # type: ignore[no-untyped-def]
        return Hub(
            clock,
            settings=settings,
            simulation_factory=simulation_factory() if args.allow_simulated else None,
        )

    app = create_app(config, hub_factory)
    frontend = args.frontend_url or origins[0]
    print("\n  oxford-hack backend (local only)")
    print(f"  listening on  http://{args.host}:{args.port}")
    print(f"  allowed origins: {', '.join(origins)}")
    if args.enable_test_hooks:
        print("  !! TEST HOOKS ENABLED (/api/v0/test/*). Never use with real participant data.")
    print(f"\n  Pair this browser tab by opening:\n    {frontend}/#pair={token}\n")
    sys.stdout.flush()
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        ws_max_size=MAX_MESSAGE_BYTES,
        log_level=args.log_level,
        access_log=False,
    )
    return 0


def replay(args: argparse.Namespace) -> int:
    from .harness.replay import run_replay

    for line in run_replay(Path(args.recording)):
        print(line)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oxford-backend")
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the local backend")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--allowed-origin", action="append", help="browser origin allowed to connect (repeatable)")
    s.add_argument("--frontend-url", help="base URL used in the printed pairing link")
    s.add_argument("--launch-token-file", default=str(DEFAULT_TOKEN_FILE))
    s.add_argument("--rotate-launch-token", action="store_true")
    s.add_argument(
        "--no-simulated",
        dest="allow_simulated",
        action="store_false",
        help="refuse simulated sessions (synthetic producers)",
    )
    s.add_argument(
        "--simulated-detector",
        choices=["placeholder", "baseline"],
        default="placeholder",
        help="simulated-session detector: scripted placeholder, or P3's inference.adapter baseline",
    )
    s.add_argument("--enable-test-hooks", action="store_true", help="expose /api/v0/test/* (tests only)")
    s.add_argument("--log-level", default="info")
    s.set_defaults(func=serve)

    r = sub.add_parser("replay", help="replay a recording deterministically and print mapped events")
    r.add_argument("recording")
    r.set_defaults(func=replay)

    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
