"""Command line: ``oxford-backend serve`` and ``oxford-backend replay``."""

from __future__ import annotations

import argparse
import ipaddress
import os
import secrets
import stat
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from .session.hub import Hub, HubSettings
    from .timing.clock import Clock

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


def _repo_root_on_path() -> None:
    """P1/P3 code lives next to platform/ (``eeg/``, ``inference/``); make it importable by name."""
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


def build_hub_factory(args: argparse.Namespace, settings: HubSettings) -> Callable[[Clock], Hub]:
    """Hub construction for ``serve`` (separate so it can be tested without binding a port)."""
    from .eeg.bridge import LiveEegBridge, load_source_factory
    from .harness.synthetic import simulation_factory
    from .session.hub import Hub

    detector_factory = None
    live_detector_factory = None
    if getattr(args, "live_eeg_reminders", False):
        _repo_root_on_path()
        if not getattr(args, "eeg_source", None):
            args.eeg_source = "inference.unicorn_source:make_source"
        if args.eeg_source == "inference.unicorn_source:make_source":
            from inference.unicorn_baseline import (  # type: ignore[import-not-found]
                inference_factory as unicorn_factory,
            )

            live_detector_factory = unicorn_factory
        else:
            from inference.live_attention import (  # type: ignore[import-not-found]
                inference_factory as live_attention_factory,
            )

            live_detector_factory = live_attention_factory
        settings.experimental_live_modes = frozenset({"eeg_only", "both"})
    if args.allow_simulated and getattr(args, "simulated_detector", "placeholder") == "baseline":
        _repo_root_on_path()
        from inference.adapter import inference_factory  # type: ignore[import-not-found,unused-ignore]  # P3

        detector_factory = inference_factory
    source_factory = None
    if getattr(args, "eeg_source", None):
        _repo_root_on_path()
        source_factory = load_source_factory(args.eeg_source)

    def hub_factory(clock: Clock) -> Hub:
        bridge = None
        if source_factory is not None:
            bridge = LiveEegBridge(source_factory(), clock)
            bridge.start()
        return Hub(
            clock,
            settings=settings,
            simulation_factory=(
                simulation_factory(detector_factory=detector_factory) if args.allow_simulated else None
            ),
            live_eeg=bridge,
            inference_factory=live_detector_factory,
        )

    return hub_factory


def serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .contracts.messages import MAX_MESSAGE_BYTES
    from .eeg.bridge import EegSourceLoadError
    from .session.hub import HubSettings
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

    try:
        hub_factory = build_hub_factory(args, settings)
    except (EegSourceLoadError, ImportError) as err:
        print(f"cannot start: {err}", file=sys.stderr)
        return 2

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
    s.add_argument(
        "--eeg-source",
        metavar="MODULE:FACTORY",
        help="Person 1's EegSource factory for live sessions, e.g. mypackage.adapter:make_source "
        "(the repository root is on the import path)",
    )
    s.add_argument("--enable-test-hooks", action="store_true", help="expose /api/v0/test/* (tests only)")
    s.add_argument(
        "--live-eeg-reminders",
        action="store_true",
        help="use physical Unicorn EEG with session baseline and 8 s review reminders (no mock fallback)",
    )
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
