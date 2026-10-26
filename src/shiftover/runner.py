"""Runs claude as a child process and swaps the account underneath the same conversation."""
import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time

from . import claude, paths, pick, usage
from .config import Account, Config
from .i18n import t

_child: subprocess.Popen | None = None


def _terminate(proc: subprocess.Popen) -> None:
    # The Stop hook that asked for the hand-off is still a child of claude; give it and the
    # transcript writer a moment before pulling the plug.
    time.sleep(1.0)
    try:
        proc.terminate()
        proc.wait(3)
        return
    except subprocess.TimeoutExpired:
        pass
    except OSError:
        return
    for _ in range(2):
        try:
            proc.send_signal(signal.SIGINT)
        except OSError:
            return
        time.sleep(0.4)
    try:
        proc.wait(3)
    except subprocess.TimeoutExpired:
        proc.kill()


def _on_usr1(signum, frame):
    proc = _child
    if proc is not None:
        threading.Thread(target=_terminate, args=(proc,), daemon=True).start()


def spawn(acct: Account, args: list[str], extra_env: dict | None = None, interactive: bool = True) -> int:
    global _child
    binary = claude.claude_bin()
    if not binary:
        print(t("no_claude"), file=sys.stderr)
        return 127
    env = claude.env_for(acct.path, extra_env)
    try:
        proc = subprocess.Popen([binary, *args], env=env)
    except OSError as e:
        print(f"shiftover: cannot start claude: {e}", file=sys.stderr)
        return 127
    _child = proc
    prev = {}
    if interactive:
        # Ctrl+C belongs to claude; the wrapper must outlive it to resume on another account.
        prev[signal.SIGINT] = signal.signal(signal.SIGINT, signal.SIG_IGN)
        prev[signal.SIGUSR1] = signal.signal(signal.SIGUSR1, _on_usr1)
    try:
        return proc.wait()
    finally:
        _child = None
        for sig, h in prev.items():
            signal.signal(sig, h)


def pretrust(src: Account, dst: Account, cwd: str) -> bool:
    """Folder trust lives per config dir; without this the resumed session opens on the trust dialog."""
    import json
    src_cfg = claude.read_config_json(src.path)
    entry = (src_cfg.get("projects") or {}).get(cwd) or {}
    if not entry.get("hasTrustDialogAccepted"):
        return False
    cj = claude.config_json(dst.path)
    dst_cfg = paths.read_json(cj, None)
    if not isinstance(dst_cfg, dict):
        return False
    projects = dst_cfg.setdefault("projects", {})
    if (projects.get(cwd) or {}).get("hasTrustDialogAccepted"):
        return False
    projects.setdefault(cwd, {})["hasTrustDialogAccepted"] = True
    tmp = cj.with_name(cj.name + ".shiftover-tmp")
    try:
        tmp.write_text(json.dumps(dst_cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, cj)
    except OSError:
        tmp.unlink(missing_ok=True)
        return False
    return True


def resume_args(flags: list[str], sid: str, model: str | None, effort: str | None) -> list[str]:
    out = list(flags)
    if model:
        out = claude.strip_flag(out, "--model") + ["--model", model]
    if effort:
        out = claude.strip_flag(out, "--effort") + ["--effort", effort]
    # --resume goes first so a trailing variadic flag (--allowedTools a b) cannot swallow it.
    return ["--resume", sid] + out


def transcript_visible(acct: Account, sid: str) -> bool:
    try:
        return any((acct.path / "projects").glob(f"*/{sid}.jsonl"))
    except OSError:
        return False


def _ask_switch(cfg: Config, cur: Account) -> Account | None:
    from . import ui
    rows = pick.rows_for(cfg, usage.refresh([a.path for a in cfg.ordered()]))
    others = [i for i, r in enumerate(rows) if r["name"] != cur.name and "limits" in r and not usage.blocking(r["limits"])]
    best = pick.best(cfg, rows, exclude=(cur.name,))
    start = next((i for i, r in enumerate(rows) if best and r["name"] == best["name"]), others[0] if others else 0)
    print(file=sys.stderr)
    idx = ui.menu(rows, start, t("switch_msg", name=cur.label), t("switch_hint"))
    if idx is None or idx < 0:
        return None
    chosen = rows[idx]["account"]
    print(f"\033[2m→ {chosen.label}\033[0m", file=sys.stderr)
    return chosen


def run(cfg: Config, acct: Account, args: list[str], interactive: bool | None = None) -> int:
    if interactive is None:
        interactive = sys.stdin.isatty() and sys.stdout.isatty() and not claude.wants_print(args)
    if not interactive:
        return spawn(acct, args, {"SHIFTOVER_ACCOUNT": acct.name, "SHIFTOVER_ACCOUNT_DIR": str(acct.path)}, interactive=False)
    rid = f"{os.getpid()}-{secrets.token_hex(4)}"
    rdir = paths.ensure_dir(paths.runs_dir() / rid)
    flags = claude.launch_flags(args)
    cur, cur_args, rc = acct, list(args), 0
    try:
        while True:
            paths.write_json(rdir / "state.json", {
                "account": cur.name, "dir": str(cur.path), "cwd": os.getcwd(), "started": time.time(), "flags": flags,
            })
            rc = spawn(cur, cur_args, {
                "SHIFTOVER_RUN_ID": rid, "SHIFTOVER_PID": str(os.getpid()),
                "SHIFTOVER_ACCOUNT": cur.name, "SHIFTOVER_ACCOUNT_DIR": str(cur.path),
            })
            sid = ""
            try:
                sid = (rdir / "sid").read_text(encoding="utf-8").strip()
            except OSError:
                pass
            req = paths.read_json(rdir / "handoff.json")
            if req and sid:
                (rdir / "handoff.json").unlink(missing_ok=True)
                target = cfg.accounts.get(req.get("target") or "")
                if target and not transcript_visible(target, sid):
                    print(t("handoff_invisible", dst=target.label, src=cur.label), file=sys.stderr)
                    paths.write_json(rdir / "notice.json", {"src": cur.name, "dst": "", "reason": req.get("reason", ""),
                                                            "detail": f"{target.name} cannot see the transcript (projects/ is not shared)"})
                    cur_args = resume_args(flags, sid, None, None)
                    continue
                if target:
                    detail = ", ".join(x for x in (req.get("model"), req.get("effort")) if x)
                    print(t("handoff_line", src=cur.label, reason=req.get("reason", ""), dst=target.label,
                            detail=f" ({detail})" if detail else ""), file=sys.stderr)
                    paths.write_json(rdir / "notice.json", {"src": cur.name, "dst": target.name, "reason": req.get("reason", "")})
                    pretrust(cur, target, os.getcwd())
                    cur_args = resume_args(flags, sid, req.get("model"), req.get("effort"))
                    cur = target
                    continue
            if cfg.handoff_mode == "ask" and sid and _has_transcript(cfg, sid):
                target = _ask_switch(cfg, cur)
                if target:
                    pretrust(cur, target, os.getcwd())
                    cur_args = resume_args(flags, sid, None, None)
                    cur = target
                    continue
            break
    finally:
        shutil.rmtree(rdir, ignore_errors=True)
    return rc


def _has_transcript(cfg: Config, sid: str) -> bool:
    for a in cfg.ordered():
        if list((a.path / "projects").glob(f"*/{sid}.jsonl")):
            return True
    return False
