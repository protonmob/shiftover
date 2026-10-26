import time

from shiftover import config, pick, usage


def rows(cfg, spec):
    entries = {}
    for a in cfg.ordered():
        s = spec.get(a.name)
        if s is None:
            entries[str(a.path)] = {"email": ""}
        elif "err" in s:
            entries[str(a.path)] = {"email": a.email, "err": s["err"]}
        else:
            entries[str(a.path)] = {"email": a.email, "limits": [
                {"kind": k, "model": "Fable" if k == "weekly_scoped" else "", "used": v, "resets_at": None} for k, v in s.items()]}
    return pick.rows_for(cfg, entries)


def test_main_first_when_free(home):
    cfg = config.load()
    r, msg = pick.choose(cfg, rows(cfg, {"main": {"session": 10}, "second": {"session": 0}, "third": {"session": 0}}), prefer="main")
    assert r["name"] == "main" and msg.startswith("→ main")


def test_falls_through_when_main_full(home):
    cfg = config.load()
    r, msg = pick.choose(cfg, rows(cfg, {"main": {"session": 100}, "second": {"session": 100}, "third": {"session": 20}}), prefer="main")
    assert r["name"] == "third" and msg.startswith("⚠") and "main: 5h full" in msg


def test_model_scoped_window_blocks_only_that_model(home):
    cfg = config.load()
    rr = rows(cfg, {"main": {"session": 10, "weekly_scoped": 100}, "second": {"session": 50}})
    assert pick.choose(cfg, rr, prefer="main", family="fable")[0]["name"] == "second"
    assert pick.choose(cfg, rr, prefer="main", family="sonnet")[0]["name"] == "main"
    assert pick.best(cfg, rr, family="fable")["name"] == "second"
    assert pick.best(cfg, rr)["name"] == "main"


def test_unreadable_and_all_full(home):
    cfg = config.load()
    r, msg = pick.choose(cfg, rows(cfg, {"main": {"err": "HTTP 401"}, "second": {"session": 100}}), prefer="main")
    assert r["name"] == "main" and "unreadable" in msg
    r, msg = pick.choose(cfg, rows(cfg, {"main": {"session": 100}, "second": {"session": 100}}), prefer="main")
    assert r["name"] in ("main", "second") and "all accounts are full" in msg
    r, msg = pick.choose(cfg, rows(cfg, {}), prefer="main")
    assert "no account is logged in" in msg


def test_models_allowlist_and_warnings(home):
    cfg = config.load()
    cfg.accounts["second"].models = ["sonnet"]
    rr = rows(cfg, {"main": {"session": 100}, "second": {"session": 0}, "third": {"session": 0}})
    assert pick.choose(cfg, rr, prefer="main", family="fable")[0]["name"] == "third"
    rr[0]["email"] = "someone-else@example.com"
    assert any("should hold one@example.com" in w for w in pick.warnings(cfg, rr))


def test_dir_map_and_resolve(home):
    cfg = config.load()
    cfg.map = {"~/work": "second", "~/work/deep": "third"}
    assert cfg.for_cwd(str(home / "work" / "x")).name == "second"
    assert cfg.for_cwd(str(home / "work" / "deep" / "y")).name == "third"
    assert cfg.for_cwd(str(home)) is None
    assert cfg.resolve("2").name == "second"
    assert cfg.resolve("thi").name == "third"
    assert cfg.resolve("two@").name == "second"
    assert cfg.resolve("nope") is None


def test_pinned_account_is_never_an_automatic_target(home):
    from shiftover import config, pick
    cfg = config.load()
    cfg.accounts["third"].pool = False
    rs = rows(cfg, {"main": {"session": 100}, "second": {"session": 100}, "third": {"session": 0}})
    assert pick.best(cfg, rs, exclude=("main",)) is None
    row, msg = pick.choose(cfg, rs, prefer="third")
    assert row["name"] == "third"
    row, msg = pick.choose(cfg, rs, prefer="main")
    assert row["name"] != "third"


def test_unreadable_main_still_opens_first(home):
    cfg = config.load()
    r, msg = pick.choose(cfg, rows(cfg, {"main": {"err": "timeout"}, "second": {"session": 0}, "third": {"session": 0}}), prefer="main")
    assert r["name"] == "main" and msg == "limits unreadable (timeout) → opening main"
    r, msg = pick.choose(cfg, rows(cfg, {"main": {"session": 100}, "second": {"session": 10}}), prefer="main")
    assert r["name"] == "second" and msg.startswith("⚠") and "main: 5h full" in msg
    r, msg = pick.choose(cfg, rows(cfg, {"second": {"session": 10}}), prefer="main")
    assert r["name"] == "second" and msg.startswith("→ second")


def _carried(cfg, main_used, resets_at=None, others=(10, 50)):
    """main cooling off a 429 with the limits read before it; the others freshly read."""
    def lims(used, rs=None):
        return [{"kind": "session", "model": "", "used": used, "resets_at": rs}]
    main, second, third = (str(a.path) for a in cfg.ordered())
    return pick.rows_for(cfg, {
        main: {"ts": 1000, "email": "one@example.com", "err": "HTTP 429", "retry_at": time.time() + 3600,
               "limits": lims(main_used, resets_at), "extra": "", "limits_ts": 900},
        second: {"ts": 1000, "email": "two@example.com", "limits": lims(others[0])},
        third: {"ts": 1000, "email": "three@example.com", "limits": lims(others[1])},
    })


def test_limits_kept_through_a_429_still_decide(home):
    cfg = config.load()
    rr = _carried(cfg, 100)
    assert rr[0]["err"].startswith("HTTP 429") and rr[0]["limits"][0]["used"] == 100 and rr[0]["limits_fetched_at"] == 900
    r, msg = pick.choose(cfg, rr, prefer="main")
    assert r["name"] == "second" and "main: 5h full" in msg and "unreadable" not in msg
    assert pick.best(cfg, rr)["name"] == "second"
    rr = _carried(cfg, 5, others=(60, 70))
    r, msg = pick.choose(cfg, rr, prefer="main")
    assert r["name"] == "main" and msg.startswith("→ main") and rr[0]["err"].startswith("HTTP 429")
    assert pick.best(cfg, rr)["name"] == "main"


def test_a_kept_window_that_has_reset_no_longer_blocks(home):
    cfg = config.load()
    rr = _carried(cfg, 100, resets_at="2000-01-01T00:00:00Z")
    assert rr[0]["limits"] == []
    assert pick.choose(cfg, rr, prefer="main")[0]["name"] == "main"
    assert pick.choose(cfg, _carried(cfg, 100, resets_at="2999-01-01T00:00:00Z"), prefer="main")[0]["name"] == "second"


def test_reported_next_refresh_is_jittered_forward(home, monkeypatch):
    cfg = config.load()
    entries = {str(a.path): {"ts": 1000, "email": a.email, "limits": []} for a in cfg.ordered()}
    seen = {r["next_refresh_at"] for _ in range(20) for r in pick.rows_for(cfg, entries)}
    assert all(1300 <= x <= 1300 + usage.JITTER for x in seen) and len(seen) > 1
    monkeypatch.setattr(pick.random, "uniform", lambda a, b: b)
    assert {r["next_refresh_at"] for r in pick.rows_for(cfg, entries)} == {1300 + usage.JITTER}
    assert all(r["next_refresh_at"] is None for r in pick.rows_for(cfg, {}))
