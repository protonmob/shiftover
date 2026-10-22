"""Claude Code hook handlers. They must never fail loudly: a hook error would land in the user's session."""
import json
import os
import sys
import time

from . import claude, config, handoff, paths, pick, runstate, usage


def _state_dir():
    return runstate.run_dir()


def session_start(data: dict) -> None:
    rd = _state_dir()
    if not rd:
        return
    f = rd / "sid"
    existing = runstate.session_id(rd)
    if existing and data.get("source") == "startup":
        return
    sid = data.get("session_id")
    if sid:
        paths.write_private(f, sid + "\n")


def _rows(cfg, budget=8.0):
    return pick.rows_for(cfg, usage.refresh([a.path for a in cfg.ordered()], budget=budget))


def _current(cfg, st: dict):
    return cfg.resolve(os.environ.get("SHIFTOVER_ACCOUNT")) or (cfg.by_dir(st.get("dir")) if st.get("dir") else None) or cfg.by_dir(claude.current_dir())


def _effort(data: dict) -> str | None:
    """Hook payloads carry effort either as a plain level or as an object describing it."""
    e = data.get("effort")
    if isinstance(e, dict):
        e = e.get("level") or e.get("value") or e.get("effort")
    return e if isinstance(e, str) and e else None


def _over(cfg, rl: dict) -> str:
    reasons = []
    for key, lab in (("five_hour", "5h window"), ("seven_day", "weekly window")):
        p = (rl.get(key) or {}).get("used_percentage")
        if isinstance(p, (int, float)) and p >= cfg.threshold:
            reasons.append(f"{lab} {p:.0f}% used")
    return "; ".join(reasons)


def _switch(cfg, rd, st: dict, reason: str, effort: str | None, target_name: str = "", model: str | None = None) -> None:
    cur = _current(cfg, st)
    model = model or (st.get("model") or {}).get("id")
    if not isinstance(model, str):
        model = None
    family = usage.model_family(model)
    target = cfg.accounts.get(target_name) if target_name else None
    if target is None:
        rows = _rows(cfg)
        row = pick.best(cfg, rows, family, exclude=(cur.name,) if cur else (), min_headroom=max(5.0, 100.0 - cfg.threshold))
        target = row["account"] if row else None
    if target is None:
        paths.write_json(rd / "notice.json", {"src": cur.name if cur else "?", "dst": "", "reason": reason})
        return
    handoff.apply(rd, {"target": target.name, "model": model, "effort": effort, "reason": reason, "session_id": runstate.session_id(rd)})


def stop(data: dict) -> None:
    rd = _state_dir()
    cfg = config.load_or_none()
    if not rd or not cfg or cfg.handoff_mode == "off":
        return
    sid = data.get("session_id") or runstate.session_id(rd)
    st = runstate.session_state(sid)
    pending = paths.read_json(rd / "pending.json")
    if pending:
        _switch(cfg, rd, st, pending.get("reason") or "manual hand-off", pending.get("effort") or _effort(data),
                pending.get("target") or "", pending.get("model"))
        return
    if cfg.handoff_mode != "auto":
        return
    reason = _over(cfg, st.get("rate_limits") or {})
    if reason:
        _switch(cfg, rd, st, reason, _effort(data))


def stop_failure(data: dict) -> None:
    if data.get("error") != "rate_limit":
        return
    rd = _state_dir()
    cfg = config.load_or_none()
    if not rd or not cfg or cfg.handoff_mode != "auto":
        return
    sid = data.get("session_id") or runstate.session_id(rd)
    _switch(cfg, rd, runstate.session_state(sid), "rate limit reached", _effort(data))


def _best_other(cfg, cur_name: str, family: str | None):
    cache = usage.load_cache()
    entries = {k: v for k, v in cache.items()}
    rows = pick.rows_for(cfg, entries)
    return pick.best(cfg, rows, family, exclude=(cur_name,))


def prompt(data: dict) -> None:
    cfg = config.load_or_none()
    if not cfg or not cfg.tips_enabled:
        return
    sid = data.get("session_id") or ""
    rd = _state_dir()
    tips_file = (rd / "tips.json") if rd else paths.sessions_dir() / f"{sid}.tips.json"
    ts = paths.read_json(tips_file, {}) or {}
    fired, last = ts.get("fired") or {}, float(ts.get("last") or 0)
    msgs = []
    if rd and (rd / "notice.json").exists():
        n = paths.read_json(rd / "notice.json", {}) or {}
        (rd / "notice.json").unlink(missing_ok=True)
        if n.get("dst"):
            msgs.append(f'shiftover: this conversation was moved from account "{n.get("src")}" to "{n.get("dst")}" '
                        f'({n.get("reason")}); model and effort were kept. The user likes a one-line heads-up about this.')
        else:
            msgs.append(f'shiftover: account "{n.get("src")}" hit a usage limit and no other account had headroom, '
                        f'so Claude Code waited for the reset. The user likes a one-line heads-up about this.')
    st = runstate.session_state(sid)
    rl = st.get("rate_limits") or {}
    cur = _current(cfg, st)
    fh = (rl.get("five_hour") or {}).get("used_percentage")
    sd = (rl.get("seven_day") or {}).get("used_percentage")
    now = time.time()
    cache = usage.load_cache()
    if cfg.ordered() and any(not usage.fresh(cache.get(str(a.path))) for a in cfg.ordered()):
        usage.refresh_detached()
    if cur and isinstance(fh, (int, float)):
        for lvl in cfg.tips_levels:
            if fh < lvl - 10:
                fired.pop(f"5h{lvl}", None)
        if isinstance(sd, (int, float)) and sd < 70:
            fired.pop("wk80", None)
        if fh < 50:
            fired.pop("delegate", None)
    if cur and isinstance(fh, (int, float)) and now - last > cfg.tips_min_interval * 60:
        family = usage.model_family((st.get("model") or {}).get("id"))
        other = _best_other(cfg, cur.name, family)
        other_txt = ""
        if other:
            other_txt = f' Account "{other["name"]}" has {usage.headroom(other["limits"], family):.0f}% headroom.'
        reset = usage.reset_in({"resets_at": (rl.get("five_hour") or {}).get("resets_at")})
        reset_txt = f" (resets in {reset})" if reset else ""
        for lvl in sorted(cfg.tips_levels, reverse=True):
            key = f"5h{lvl}"
            if fh >= lvl and not fired.get(key):
                fired[key] = True
                mode = {"auto": f"a hand-off to another account happens automatically at {cfg.threshold}%",
                        "ask": "run /handoff to continue on another account",
                        "off": "automatic hand-off is off"}[cfg.handoff_mode if cfg.handoff_mode in ("auto", "ask", "off") else "off"]
                msgs.append(f'shiftover: account "{cur.name}" has used {fh:.0f}% of its 5-hour window{reset_txt}.{other_txt} '
                            f'Note: {mode}. The user likes a one-line heads-up about this.')
                break
        if isinstance(sd, (int, float)) and sd >= 80 and not fired.get("wk80"):
            fired["wk80"] = True
            wreset = usage.reset_in({"resets_at": (rl.get("seven_day") or {}).get("resets_at")})
            msgs.append(f'shiftover: account "{cur.name}" has used {sd:.0f}% of its weekly window'
                        f'{f" (resets in {wreset})" if wreset else ""}.{other_txt} The user likes a one-line heads-up about this.')
        if other and fh >= 60 and not fired.get("delegate"):
            gap = usage.headroom(other["limits"], family) - (100 - fh)
            if gap >= 40:
                fired["delegate"] = True
                msgs.append(f'shiftover: the `delegate` MCP tool (server "shiftover") can run a self-contained task on account '
                            f'"{other["name"]}", which has {gap:.0f} points more headroom than "{cur.name}". '
                            f'Worth mentioning to the user in one line when a heavy step comes up.')
    if msgs:
        paths.write_json(tips_file, {"last": now, "fired": fired})
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "\n".join(msgs)}}))
    elif ts.get("fired") != fired:
        paths.write_json(tips_file, {"last": last, "fired": fired})


HANDLERS = {"session-start": session_start, "stop": stop, "stop-failure": stop_failure, "prompt": prompt}


def main(event: str) -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    h = HANDLERS.get(event)
    if not h:
        print(f"shiftover: unknown hook event {event}", file=sys.stderr)
        return 0
    try:
        h(data)
    except Exception as e:  # noqa: BLE001 - never break the user's session because of a tip
        paths.log(f"hook {event}: {e!r}")
    return 0
