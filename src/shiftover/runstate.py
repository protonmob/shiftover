"""Per-run files shared by the runner and the hooks it spawns."""
import os
from pathlib import Path

from . import paths


def run_id() -> str | None:
    return os.environ.get("SHIFTOVER_RUN_ID") or None


def run_dir(create: bool = False) -> Path | None:
    rid = run_id()
    if not rid:
        return None
    d = paths.runs_dir() / rid
    if create:
        paths.ensure_dir(d)
    return d if d.is_dir() else None


def session_id(rd: Path | None) -> str:
    if not rd:
        return ""
    try:
        return (rd / "sid").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def session_state(sid: str) -> dict:
    return paths.read_json(paths.sessions_dir() / f"{sid}.json", {}) or {}


def wrapper_pid() -> int:
    try:
        return int(os.environ.get("SHIFTOVER_PID") or 0)
    except ValueError:
        return 0
