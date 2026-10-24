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


def test_stop_skips_targets_that_cannot_see_the_transcript(home, monkeypatch):
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("s9")
    _usage_cache(home, {"main": 99, "second": 10, "third": 20})
    paths.write_json(paths.sessions_dir() / "s9.json", {"ts": 10**12, "dir": str(home / ".claude"), "account": "main",
                                                        "rate_limits": {"five_hour": {"used_percentage": 99}}})
    tp = home / ".claude" / "projects" / "-x" / "s9.jsonl"
    tp.parent.mkdir(parents=True)
    tp.write_text("{}")
    (home / ".claude-second" / "projects").symlink_to(home / ".claude" / "projects")
    monkeypatch.setattr(hooks.handoff, "apply", lambda rd_, req: paths.write_json(rd_ / "handoff.json", req))
    hooks.stop({"session_id": "s9", "transcript_path": str(tp)})
    assert paths.read_json(rd / "handoff.json")["target"] == "second"


def test_pinned_account_never_hands_off_by_itself(home, monkeypatch):
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("s8")
    cfg = config.load()
    cfg.accounts["main"].pool = False
    config.save(cfg)
    _usage_cache(home, {"main": 99, "second": 10, "third": 20})
    paths.write_json(paths.sessions_dir() / "s8.json", {"ts": 10**12, "dir": str(home / ".claude"), "account": "main",
                                                        "rate_limits": {"five_hour": {"used_percentage": 99}}})
    monkeypatch.setattr(hooks.handoff, "apply", lambda rd_, req: paths.write_json(rd_ / "handoff.json", req))
    hooks.stop({"session_id": "s8"})
    assert not (rd / "handoff.json").exists()


def _limits_cache(home, spec, ts=10**12):
    """spec: {account: [(kind, model, used, resets_at), ...]} written as the usage cache."""
    cfg = config.load()
    paths.write_json(usage.cache_path(), {str(cfg.accounts[n].path): {"ts": ts, "email": cfg.accounts[n].email, "limits": [
        {"kind": k, "model": m, "used": u, "resets_at": r} for k, m, u, r in lims]} for n, lims in spec.items()})


def test_over_cached_reads_the_model_window_the_status_line_lacks(home, monkeypatch):
    spawned = []
    monkeypatch.setattr(usage, "refresh_detached", lambda: spawned.append(1))
    cfg = config.load()
    main = cfg.accounts["main"]
    _limits_cache(home, {"main": [("session", "", 40, None), ("weekly_scoped", "Fable", 95, None)]})
    assert hooks._over_cached(cfg, main, "fable") == "Fable weekly window 95% used"
    assert hooks._over_cached(cfg, main, "sonnet") == ""
    assert hooks._over_cached(cfg, main, None) == ""
    _limits_cache(home, {"main": [("session", "", 96, "2000-01-01T00:00:00Z"), ("weekly_all", "", 97, None)]})
    assert hooks._over_cached(cfg, main, "fable") == "weekly window 97% used"
    assert spawned == []


def test_over_cached_with_a_stale_entry_only_schedules_a_refresh(home, monkeypatch):
    spawned = []
    monkeypatch.setattr(usage, "refresh_detached", lambda: spawned.append(1))
    cfg = config.load()
    _limits_cache(home, {"main": [("weekly_scoped", "Fable", 100, None)]}, ts=1)
    assert hooks._over_cached(cfg, cfg.accounts["main"], "fable") == "" and spawned == [1]
    paths.write_json(usage.cache_path(), {})
    assert hooks._over_cached(cfg, cfg.accounts["main"], "fable") == "" and spawned == [1, 1]


def test_stop_hands_off_on_a_full_model_window_using_the_settings_model(home, monkeypatch):
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("s7")
    monkeypatch.setattr(usage, "refresh_detached", lambda: None)
    monkeypatch.setattr(hooks.handoff, "apply", lambda rd_, req: paths.write_json(rd_ / "handoff.json", req))
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "fable"}))
    paths.write_json(paths.sessions_dir() / "s7.json", {"dir": str(home / ".claude"), "account": "main",
                                                        "rate_limits": {"five_hour": {"used_percentage": 20}}})
    _limits_cache(home, {"main": [("session", "", 20, None), ("weekly_scoped", "Fable", 97, None)],
                         "second": [("session", "", 5, None), ("weekly_scoped", "Fable", 100, None)],
                         "third": [("session", "", 30, None), ("weekly_scoped", "Fable", 10, None)]})
    hooks.stop({"session_id": "s7"})
    req = paths.read_json(rd / "handoff.json")
    assert req["target"] == "third" and req["reason"] == "Fable weekly window 97% used" and req["model"] is None


def test_prompt_tip_counts_the_settings_model_window(home, monkeypatch, capsys):
    rd = _run_env(monkeypatch, home)
    (rd / "sid").write_text("s6")
    monkeypatch.setattr(usage, "refresh_detached", lambda: None)
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "fable"}))
    paths.write_json(paths.sessions_dir() / "s6.json", {"dir": str(home / ".claude"), "rate_limits": {"five_hour": {"used_percentage": 80}}})
    _limits_cache(home, {"main": [("session", "", 80, None)],
                         "second": [("session", "", 5, None), ("weekly_scoped", "Fable", 100, None)],
                         "third": [("session", "", 60, None), ("weekly_scoped", "Fable", 10, None)]})
    hooks.prompt({"session_id": "s6"})
    ctx = json.loads(capsys.readouterr().out)["hookSpecificOutput"]["additionalContext"]
    assert 'Account "third" has 40% headroom' in ctx and '"second"' not in ctx
