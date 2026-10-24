from shiftover import config, pick


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
