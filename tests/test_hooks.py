import json
import os
import signal

from shiftover import config, hooks, paths, runstate, usage


def _run_env(monkeypatch, home, pid=None):
    rid = "123-abcd"
    rd = paths.runs_dir() / rid
    paths.ensure_dir(rd)
    monkeypatch.setenv("SHIFTOVER_RUN_ID", rid)
    monkeypatch.setenv("SHIFTOVER_PID", str(pid or os.getpid()))
    monkeypatch.setenv("SHIFTOVER_ACCOUNT", "main")
    monkeypatch.setenv("SHIFTOVER_ACCOUNT_DIR", str(home / ".claude"))
    return rd


def _usage_cache(home, spec):
    cfg = config.load()
    cache = {}
    for a in cfg.ordered():
        used = spec.get(a.name, 0)
        cache[str(a.path)] = {"ts": 10**12, "email": a.email, "limits": [{"kind": "session", "model": "", "used": used, "resets_at": None}]}
    paths.write_json(usage.cache_path(), cache)


def test_session_start_records_sid(home, monkeypatch):
    rd = _run_env(monkeypatch, home)
    hooks.session_start({"session_id": "s1", "source": "startup"})
    assert runstate.session_id(rd) == "s1"
    hooks.session_start({"session_id": "s2", "source": "startup"})
    assert runstate.session_id(rd) == "s1"
    hooks.session_start({"session_id": "s3", "source": "clear"})
    assert runstate.session_id(rd) == "s3"


def test_stop_hands_off_over_threshold(home, monkeypatch):
    got = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: got.append((pid, sig)))
    rd = _run_env(monkeypatch, home, pid=4242)
    (rd / "sid").write_text("sid-1\n")
    paths.write_json(paths.sessions_dir() / "sid-1.json", {"dir": str(home / ".claude"), "model": {"id": "claude-fable-5-1"},
                                                           "rate_limits": {"five_hour": {"used_percentage": 97, "resets_at": 0}}})
    _usage_cache(home, {"main": 97, "second": 80, "third": 20})
    hooks.stop({"session_id": "sid-1", "effort": {"level": "max", "source": "session"}})
    req = paths.read_json(rd / "handoff.json")
    assert req["target"] == "third" and req["model"] == "claude-fable-5-1" and req["effort"] == "max"
    assert "5h window 97%" in req["reason"]
    assert got == [(4242, signal.SIGUSR1)]


def test_stop_does_nothing_below_threshold_or_without_target(home, monkeypatch):
    got = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: got.append((pid, sig)))
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("sid-2\n")
    paths.write_json(paths.sessions_dir() / "sid-2.json", {"dir": str(home / ".claude"), "rate_limits": {"five_hour": {"used_percentage": 50}}})
    _usage_cache(home, {"main": 50, "second": 100, "third": 100})
    hooks.stop({"session_id": "sid-2"})
    assert not (rd / "handoff.json").exists() and not got
    paths.write_json(paths.sessions_dir() / "sid-2.json", {"dir": str(home / ".claude"), "rate_limits": {"five_hour": {"used_percentage": 99}}})
    hooks.stop({"session_id": "sid-2"})
    assert not (rd / "handoff.json").exists() and not got
    assert paths.read_json(rd / "notice.json")["dst"] == ""


def test_pending_manual_handoff_and_stop_failure(home, monkeypatch):
    got = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: got.append((pid, sig)))
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("sid-3\n")
    _usage_cache(home, {"main": 10, "second": 10, "third": 10})
    paths.write_json(rd / "pending.json", {"target": "second", "model": "opus", "effort": None, "reason": "manual hand-off"})
    hooks.stop({"session_id": "sid-3", "effort": "high"})
    req = paths.read_json(rd / "handoff.json")
    assert req["target"] == "second" and req["model"] == "opus" and req["effort"] == "high"
    assert not (rd / "pending.json").exists()
    (rd / "handoff.json").unlink()
    hooks.stop_failure({"session_id": "sid-3", "error": "overloaded"})
    assert not (rd / "handoff.json").exists()
    hooks.stop_failure({"session_id": "sid-3", "error": "rate_limit"})
    assert paths.read_json(rd / "handoff.json")["reason"] == "rate limit reached"
    assert len(got) == 2


def test_prompt_tips_fire_once_per_level(home, monkeypatch, capsys):
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("sid-4\n")
    monkeypatch.setattr(usage, "refresh_detached", lambda: None)
    _usage_cache(home, {"main": 80, "second": 5, "third": 60})
    paths.write_json(paths.sessions_dir() / "sid-4.json", {"dir": str(home / ".claude"), "rate_limits": {"five_hour": {"used_percentage": 80}}})
    hooks.prompt({"session_id": "sid-4"})
    out = json.loads(capsys.readouterr().out)
    ctx = out["hookSpecificOutput"]["additionalContext"]
    assert "80% of its 5-hour window" in ctx and '"second"' in ctx and "delegate" in ctx
    hooks.prompt({"session_id": "sid-4"})
    assert capsys.readouterr().out == ""
    paths.write_json(rd / "notice.json", {"src": "main", "dst": "second", "reason": "5h window 97% used"})
    hooks.prompt({"session_id": "sid-4"})
    assert "moved from account" in capsys.readouterr().out
