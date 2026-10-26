import json
import os
import signal
import subprocess
import sys
import time

from . import claude, config, paths, usage
from .ui import Style


def segment(acct_name: str, rl: dict, st: Style) -> str:
    parts = []
    for key, lab in (("five_hour", "5h"), ("seven_day", "wk")):
        w = rl.get(key) or {}
        p = w.get("used_percentage")
        if p is None:
            continue
        col = st.green if p < 50 else st.yellow if p < 80 else st.red
        parts.append(f"{lab} {col}{p:.0f}%{st.reset}")
    name = acct_name or "?"
    return " ".join([f"{st.bold}{name}{st.reset}"] + parts) if parts else f"{st.bold}{name}{st.reset}"


def _wrapped(wrap: str, raw: str) -> str:
    if not wrap:
        return ""
    try:
        proc = subprocess.Popen(wrap, shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return ""
    try:
        out, _ = proc.communicate(raw.encode("utf-8", "replace"), timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.wait()
        return ""
    except Exception:  # noqa: BLE001 - a broken wrapper must not take the status line down
        return ""
    return out.decode("utf-8", "replace").rstrip("\n")


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    cfg = config.load_or_none()
    d = claude.current_dir()
    acct = cfg.by_dir(d) if cfg else None
    sid = data.get("session_id")
    rl = data.get("rate_limits") or {}
    if sid:
        try:
            paths.write_json(paths.sessions_dir() / f"{sid}.json", {
                "ts": time.time(), "dir": str(d), "account": acct.name if acct else "",
                "model": data.get("model") or {}, "rate_limits": rl,
                "cwd": (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or "",
            })
        except OSError:
            pass
    base = _wrapped(cfg.statusline_wrap if cfg else "", raw)
    if not base:
        model = (data.get("model") or {}).get("display_name") or ""
        ctx = (data.get("context_window") or {}).get("used_percentage")
        base = model + (f"  {ctx:.0f}% ctx" if isinstance(ctx, (int, float)) else "")
    st = Style(None, force=True)
    seg = segment(acct.label if acct else d.name, rl, st)
    lines = base.split("\n")
    lines[0] = f"{lines[0]} · {seg}" if lines[0] else seg
    print("\n".join(lines))
    return 0
