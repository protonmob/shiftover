import argparse
import json
import os
import subprocess
from pathlib import Path

import pytest

from shiftover import cli, config, hooks, i18n, paths, runner, ui, usage
from shiftover.delegate import mcp


def _seed_limits(spec):
    cfg = config.load()
    paths.write_json(usage.cache_path(), {str(cfg.accounts[n].path): {"ts": 10**12, "email": cfg.accounts[n].email, "limits": [
        {"kind": k, "model": m, "used": u, "resets_at": None} for k, m, u in lims]} for n, lims in spec.items()})


def _capture_run(monkeypatch):
    seen = []
    monkeypatch.setattr(cli.claude, "claude_bin", lambda: "claude")
    monkeypatch.setattr(runner, "run", lambda cfg, acct, args, interactive=None: seen.append((acct.name, list(args))) or 0)
    return seen


def test_cl_opens_the_main_flow_and_leaves_the_menu_opt_in(capsys):
    cli.cmd_shell_init(argparse.Namespace(no_cl=False))
    init = capsys.readouterr().out
    assert "--menu" not in init
    script = ('shiftover() { printf "%s|" "$@"; echo; }\n' + init +
              '\ncl "$1" --dangerously-skip-permissions\ncl "$1" --menu -x\ncl --menu\ncl -p hi\n')
    out = subprocess.run(["bash", "-c", script, "bash", "/"], capture_output=True, text=True, check=True).stdout
    assert out.splitlines() == ["run|-C|/|--dangerously-skip-permissions|", "run|-C|/|--menu|-x|", "run|--menu|", "run|-p|hi|"]


def test_run_takes_menu_on_either_side_of_chdir(home, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    seen = _capture_run(monkeypatch)
    shown = []
    monkeypatch.setattr(ui, "menu", lambda rows, sel, msg, hint: shown.append(rows[sel]["name"]) or sel)
    _seed_limits({"main": [("session", "", 10)], "second": [("session", "", 10)], "third": [("session", "", 10)]})
    proj = tmp_path / "proj"
    proj.mkdir()
    for argv in (["-C", str(proj), "--menu", "--dangerously-skip-permissions"],
                 ["--menu", "-C", str(proj), "--dangerously-skip-permissions"]):
        os.chdir(tmp_path)
        assert cli.cmd_run(argv) == 0
        assert Path(os.getcwd()).resolve() == proj.resolve()
    assert shown == ["main", "main"] and seen == [("main", ["--dangerously-skip-permissions"])] * 2


def test_run_counts_the_model_window_of_the_settings_default(home, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    seen = _capture_run(monkeypatch)
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "fable"}))
    _seed_limits({"main": [("session", "", 10), ("weekly_scoped", "Fable", 100)],
                  "second": [("session", "", 50)], "third": [("session", "", 60)]})
    assert cli.cmd_run(["--dangerously-skip-permissions"]) == 0
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
    assert cli.cmd_run([]) == 0
    assert cli.cmd_run(["--model", "fable"]) == 0
    assert [name for name, _ in seen] == ["second", "main", "second"]


@pytest.mark.parametrize("no_usage", [False, True])
def test_status_json_includes_cache_timing(home, monkeypatch, capsys, no_usage):
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("fresh account probed"))
    cfg = config.load()
    entries = [{"ts": 1000.5, "limits": []}, {"ts": 1000.5, "err": "timeout"},
               {"ts": 1000.5, "err": "HTTP 429", "retry_at": 4493.5}]
    paths.write_json(usage.cache_path(), {str(a.path): {"email": a.email, **e} for a, e in zip(cfg.ordered(), entries)})
    if no_usage:
        monkeypatch.setattr(usage, "refresh", lambda *a, **kw: pytest.fail("usage requested"))
    assert cli.main(["status", "--json"] + (["--no-usage"] if no_usage else [])) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [r["fetched_at"] for r in rows] == ([None] * 3 if no_usage else [1000.5] * 3)
    # Jittered forward a few seconds, so the panels of several tabs do not wake together.
    exact = [None] * 3 if no_usage else [1300.5, 1060.5, 4493.5]
    assert all(r["next_refresh_at"] is None if x is None else x <= r["next_refresh_at"] <= x + usage.JITTER
               for r, x in zip(rows, exact))


def test_status_json_without_cache_timestamps(home, monkeypatch, capsys):
    monkeypatch.setattr(usage, "refresh", lambda *a, **kw: {})
    assert cli.main(["status", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert len(rows) == 3
    assert all(r["fetched_at"] is None and r["next_refresh_at"] is None for r in rows)


@pytest.mark.parametrize("lang, message", [("en", "HTTP 429 (retry in 42m)"),
                                        ("tr", "HTTP 429 (42 dk sonra yeniden denenecek)")])
def test_retry_message_in_usage_text_and_status_json(home, monkeypatch, capsys, lang, message):
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("cooling account probed"))
    cfg = config.load()
    cfg.lang = lang
    config.save(cfg)
    cache = {str(a.path): {"ts": 1000, "email": a.email, "token_fp": "", "limits": []} for a in cfg.ordered()}
    key = str(cfg.main_account().path)
    cache[key] = {"ts": 1000, "email": "one@example.com", "token_fp": "", "err": "HTTP 429", "retry_at": 3520}
    paths.write_json(usage.cache_path(), cache)
    assert cli.main(["usage"]) == 0
    assert f"main: {message}" in capsys.readouterr().out
    assert cli.main(["status", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["err"] == message
    assert cli.main(["usage", "--raw"]) == 0
    assert f"main: {message}" in capsys.readouterr().out


def test_status_reads_the_keychain_only_for_stale_or_failing_accounts(home, monkeypatch, capsys):
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    cfg = config.load()
    main, second, third = (str(a.path) for a in cfg.ordered())
    cache = {str(a.path): {"ts": 1000, "email": a.email, "token_fp": usage.fingerprint("old"), "limits": []}
             for a in cfg.ordered()}
    cache[main].update(err="HTTP 429", retry_at=7000)
    cache[third]["ts"] = 600
    paths.write_json(usage.cache_path(), cache)
    probes, lookups = [], []
    monkeypatch.setattr(usage.claude, "access_token", lambda d: lookups.append(str(d)) or ("new" if str(d) == main else "old"))
    monkeypatch.setattr(usage, "fetch", lambda tok: probes.append(tok) or ({"five_hour": {"utilization": 12}}, None, None))
    assert cli.main(["status", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    # The re-login on the account cooling off a 429 is noticed at once; the fresh good account is not looked up.
    assert "err" not in rows[0] and rows[0]["limits"][0]["used"] == 12
    assert sorted(lookups) == sorted([main, third]) and sorted(probes) == ["new", "old"]
    lookups.clear()
    assert cli.main(["status", "--json"]) == 0
    assert lookups == [] and len(probes) == 2
    capsys.readouterr()


def test_status_json_keeps_the_limits_a_429_did_not_refresh(home, monkeypatch, capsys):
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("cooling account probed"))
    cfg = config.load()
    lims = [{"kind": "session", "model": "", "used": 100.0, "resets_at": None}]
    cache = {str(a.path): {"ts": 1000, "email": a.email, "token_fp": "", "limits": []} for a in cfg.ordered()}
    cache[str(cfg.main_account().path)] = {"ts": 1000, "email": "one@example.com", "token_fp": "", "err": "HTTP 429",
                                           "retry_at": 3520, "limits": lims, "extra": "", "limits_ts": 700}
    paths.write_json(usage.cache_path(), cache)
    assert cli.main(["status", "--json"]) == 0
    row = json.loads(capsys.readouterr().out)[0]
    assert row["err"] == "HTTP 429 (retry in 42m)" and row["limits"] == lims and row["headroom"] == 0
    assert row["limits_fetched_at"] == 700 and row["fetched_at"] == 1000
    rows = cli._rows(cfg, True)
    line = next(p for p, _ in ui.build_lines(rows, ui.Style(None)) if "one@example.com" in p)
    assert "100%" in line and "HTTP 429 (retry in 42m)" in line
    narrow = [p.strip() for p, _ in ui.build_lines(rows, ui.Style(None), cols=40)]
    assert "HTTP 429 (retry in 42m)" in narrow


def test_usage_stale_routes_to_the_background_lock(home, monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(usage, "refresh_stale", lambda dirs: seen.append(dirs) or {})
    assert cli.main(["usage", "--stale", "--quiet"]) == 0
    assert seen == [[a.path for a in config.load().ordered()]]
    assert capsys.readouterr().out == ""


def test_raw_usage_records_and_respects_retry_after(home, monkeypatch, capsys):
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage.claude, "access_token", lambda d: "test")
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or (None, "HTTP 429", "3493"))
    assert cli.main(["usage", "--raw"]) == 0
    assert "HTTP 429 (retry in 59m)" in capsys.readouterr().out
    assert len(seen) == 3
    assert all(e["retry_at"] == 4493 for e in usage.load_cache().values())
    assert cli.main(["usage", "--raw"]) == 0
    assert len(seen) == 3


def test_raw_usage_429_keeps_the_last_limits(home, monkeypatch, capsys):
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage.claude, "access_token", lambda d: "test")
    monkeypatch.setattr(usage, "fetch", lambda tok: (None, "HTTP 429", "60"))
    lims = [{"kind": "session", "model": "", "used": 40.0, "resets_at": None}]
    paths.write_json(usage.cache_path(), {str(a.path): {"ts": 600, "email": a.email, "token_fp": usage.fingerprint("test"),
                                                         "limits": lims, "extra": ""} for a in config.load().ordered()})
    assert cli.main(["usage", "--raw"]) == 0
    capsys.readouterr()
    assert all(e["limits"] == lims and e["limits_ts"] == 600 and e["retry_at"] == 1060 for e in usage.load_cache().values())


def test_display_names_show_in_text_and_json_while_names_stay_the_keys(home, monkeypatch, capsys):
    monkeypatch.setattr(i18n, "LANG", "en")
    seen = _capture_run(monkeypatch)
    cfg = config.load()
    cfg.accounts["main"].display = "Kadir"
    cfg.accounts["second"].display = "İş"
    config.save(cfg)
    _seed_limits({"main": [("session", "", 100)], "second": [("session", "", 10)], "third": [("session", "", 10)]})
    assert cli.main(["status", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [(r["name"], r["display"]) for r in rows] == [("main", "Kadir"), ("second", "İş"), ("third", None)]
    lines = [p for p, _ in ui.build_lines(cli._rows(config.load(), True), ui.Style(None))]
    assert any(ln.lstrip().startswith("1  Kadir") for ln in lines) and any("İş" in ln for ln in lines)
    assert any(ln.lstrip().startswith("3  third") for ln in lines)
    # The picker's message names accounts by display name; the account itself is chosen and passed by name.
    assert cli.cmd_run(["-p", "hi"]) == 0
    assert "Kadir: 5h full" in capsys.readouterr().err and seen[-1][0] == "second"
    assert cli.cmd_run(["-a", "second", "-p", "hi"]) == 0 and seen[-1][0] == "second"
    assert cli.cmd_run(["-a", "İş", "-p", "hi"]) == 1
    assert "unknown account: İş" in capsys.readouterr().err


def test_the_status_line_shows_the_display_name(home, monkeypatch, capsys):
    import io
    from shiftover import statusline
    cfg = config.load()
    cfg.accounts["main"].display = "Kadir"
    config.save(cfg)
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"session_id": "s-display", "model": {"display_name": "Opus"},
                                                             "rate_limits": {"five_hour": {"used_percentage": 12}}})))
    assert statusline.main() == 0
    out = capsys.readouterr().out
    assert "Kadir" in out and "main" not in out
    # The session file keeps the name: hooks and the panel look accounts up by it.
    assert paths.read_json(paths.sessions_dir() / "s-display.json")["account"] == "main"


def _expired_tokens(monkeypatch, lang="en"):
    """Every account's token expired after its windows were read; sending or renewing it fails the test."""
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    cfg = config.load()
    cfg.lang = lang
    config.save(cfg)
    lims = [{"kind": "session", "model": "", "used": 40.0, "resets_at": None}]
    paths.write_json(usage.cache_path(), {str(a.path): {"ts": 600, "email": a.email, "token_fp": usage.fingerprint("test"),
                                                         "limits": lims, "extra": ""} for a in cfg.ordered()})
    tok = usage.claude.Token("test")
    tok.expires_at = 900
    monkeypatch.setattr(usage.claude, "access_token", lambda d: tok)
    monkeypatch.setattr(usage.claude, "renew", lambda d: pytest.fail("renewed while a caller waits"))
    monkeypatch.setattr(usage, "fetch", lambda t: pytest.fail("an expired token was sent"))
    spawned = []
    monkeypatch.setattr(usage, "refresh_detached", lambda: spawned.append(1))
    return lims, spawned


WAITING_CALLERS = {
    "status --json": lambda: cli.main(["status", "--json"]),
    "status --refresh": lambda: cli.main(["status", "--refresh", "--json"]),
    "usage": lambda: cli.main(["usage"]),
    "run": lambda: cli.cmd_run(["-p", "hi"]),
    "stop hook": lambda: hooks._rows(config.load()),
    "mcp accounts": lambda: mcp.Server().accounts({}),
    "mcp accounts refresh": lambda: mcp.Server().accounts({"refresh": True}),
    "mcp delegate auto": lambda: mcp.Server()._pick_account(config.load(), "auto", None),
}


@pytest.mark.parametrize("caller", WAITING_CALLERS)
def test_waiting_callers_never_renew_a_token(home, monkeypatch, capsys, caller):
    lims, spawned = _expired_tokens(monkeypatch)
    _capture_run(monkeypatch)
    WAITING_CALLERS[caller]()
    capsys.readouterr()
    # They report the renewal with the last windows and leave it to the detached background refresh.
    assert all(e["err"] == usage.RENEWING and e["limits"] == lims for e in usage.load_cache().values())
    assert spawned


@pytest.mark.parametrize("lang, renewing", [("en", "renewing token"), ("tr", "anahtar yenileniyor")])
def test_status_json_shows_a_renewing_token_with_its_last_limits(home, monkeypatch, capsys, lang, renewing):
    lims, spawned = _expired_tokens(monkeypatch, lang)
    assert cli.main(["status", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [(r["err"], r["limits"], r["headroom"], r["limits_fetched_at"]) for r in rows] == [(renewing, lims, 60, 600)] * 3
    assert spawned == [1]


@pytest.mark.parametrize("lang, login", [("en", "login required"), ("tr", "giriş gerekli: hesabı açıp giriş yap")])
def test_status_json_shows_login_required_through_the_backoff(home, monkeypatch, capsys, lang, login):
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage, "fetch", lambda t: pytest.fail("probed during the backoff"))
    cfg = config.load()
    cfg.lang = lang
    config.save(cfg)
    paths.write_json(usage.cache_path(), {str(a.path): {"ts": 1000, "email": a.email, "token_fp": "", "renew_at": 1000,
                                                         "err": usage.LOGIN_REQUIRED} for a in cfg.ordered()})
    assert cli.main(["status", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [r["err"] for r in rows] == [login] * 3 and not any("limits" in r for r in rows)
