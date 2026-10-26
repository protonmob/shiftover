import concurrent.futures
import fcntl
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error

import pytest

from shiftover import i18n, paths, usage
from tests.conftest import SRC


@pytest.fixture
def account(home, monkeypatch):
    monkeypatch.setattr(usage.time, "time", lambda: 1000)
    monkeypatch.setattr(usage.claude, "access_token", lambda d: "test")
    # A refused token asks for the background refresh: never start a real one from a test.
    monkeypatch.setattr(usage, "refresh_detached", lambda: None)
    return str(home / ".claude")


def test_parse_limits_new_shape():
    data = {"limits": [
        {"kind": "weekly_scoped", "percent": 40, "resets_at": "2026-10-23T00:00:00Z", "scope": {"model": {"display_name": "Fable"}}},
        {"kind": "session", "percent": 12.5, "resets_at": "2026-10-22T18:00:00Z"},
        {"kind": "weekly_all", "percent": 100, "resets_at": None},
        {"kind": "bogus", "percent": 1},
    ]}
    lims = usage.parse_limits(data)
    assert [x["kind"] for x in lims] == ["session", "weekly_all", "weekly_scoped"]
    assert lims[2]["model"] == "Fable"
    assert usage.blocking(lims) and usage.blocking(lims)[0]["kind"] == "weekly_all"


def test_parse_limits_legacy_shape():
    lims = usage.parse_limits({"five_hour": {"utilization": 3, "resets_at": None}, "seven_day": {"utilization": 50}})
    assert [(x["kind"], x["used"]) for x in lims] == [("session", 3.0), ("weekly_all", 50.0)]


def test_headroom_is_model_aware():
    lims = [{"kind": "session", "model": "", "used": 10, "resets_at": None},
            {"kind": "weekly_scoped", "model": "Fable", "used": 95, "resets_at": None}]
    assert usage.headroom(lims) == 90
    assert usage.headroom(lims, "fable") == 5
    assert usage.headroom(lims, "sonnet") == 90
    assert usage.model_family("claude-fable-5-1") == "fable"
    assert usage.model_family("Opus") == "opus"
    assert usage.model_family(None) is None


@pytest.mark.parametrize("entry, expected", [
    ({"ts": 1000.5, "limits": []}, 1300.5),
    ({"ts": 1000.5, "err": "timeout"}, 1060.5),
    ({"ts": 1000.5, "err": "HTTP 429", "retry_at": 4493.5}, 4493.5),
    ({"ts": 1000, "err": "HTTP 429", "retry_at": 0}, 0.0),
    ({"ts": 1000, "err": "HTTP 429"}, 1060.0),
    ({"ts": 1000, "retry_at": None}, 1300.0),
    ({"ts": 1000, "err": "HTTP 401 (token expired: open claude once with this account)"}, 1300.0),
    ({"ts": 1000, "err": "no token (allow keychain access)"}, 1300.0),
    ({"ts": 1000, "err": usage.RENEWING}, 1060.0),
    ({"ts": 1000, "err": usage.LOGIN_REQUIRED, "renew_at": 1000}, 1300.0),
    ({"ts": 0}, 300.0),
    (None, None), ({}, None), ({"err": "unknown"}, None), ({"ts": None}, None),
    ({"retry_at": 4493}, None),
])
def test_next_refresh(entry, expected):
    assert usage.next_refresh(entry) == expected


@pytest.mark.parametrize("entry", [
    {"ts": 1000, "limits": []},
    {"ts": 1000, "err": "timeout"},
    {"ts": 1000, "err": "HTTP 429", "retry_at": 4493},
    {"ts": 1000, "err": "HTTP 401 (token expired: open claude once with this account)"},
    {"ts": 1000, "err": usage.RENEWING},
    {"ts": 1000, "err": usage.LOGIN_REQUIRED, "renew_at": 1000},
])
def test_next_refresh_matches_fresh_boundary(monkeypatch, entry):
    deadline = usage.next_refresh(entry)
    monkeypatch.setattr(usage.time, "time", lambda: deadline - 0.1)
    assert usage.fresh(entry)
    monkeypatch.setattr(usage.time, "time", lambda: deadline)
    assert not usage.fresh(entry)


def test_detached_refresh_does_not_force(monkeypatch):
    seen = []
    monkeypatch.setattr(usage.subprocess, "Popen", lambda args, **kw: seen.append((args, kw)))
    usage.refresh_detached()
    args, kw = seen[0]
    assert args == [sys.executable, "-m", "shiftover", "usage", "--stale", "--quiet"]
    assert kw["start_new_session"] and kw["stderr"] == subprocess.DEVNULL


def _hold_lock():
    """A child process holding the usage lock until its stdin closes."""
    paths.ensure_dir(paths.cache_dir())
    child = subprocess.Popen([sys.executable, "-c", """
import fcntl, sys
with open(sys.argv[1], 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print('ready', flush=True)
    sys.stdin.read()
""", str(paths.cache_dir() / "usage.lock")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert child.stdout.readline().strip() == "ready"
    return child


def test_background_refresh_has_a_nonblocking_process_lock(home, monkeypatch):
    lock_path = paths.cache_dir() / "usage.lock"
    seen = []

    def refresh(dirs, ttl, force, budget, renew=False):
        assert budget is None and not force and renew
        with lock_path.open("a") as lock:
            with pytest.raises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        seen.append(dirs)
        return {"done": True}

    monkeypatch.setattr(usage, "_refresh", refresh)
    child = _hold_lock()
    try:
        assert usage.refresh_stale(["account"]) == {}
        assert not seen
    finally:
        child.communicate(timeout=5)
    assert usage.refresh_stale(["account"]) == {"done": True}
    assert seen == [["account"]]


def test_refresh_reports_the_cache_while_another_process_probes(account, monkeypatch):
    stale = {"ts": 600, "email": "one@example.com", "token_fp": usage.fingerprint("test"), "limits": []}
    paths.write_json(usage.cache_path(), {account: stale})
    monkeypatch.setattr(usage.claude, "access_token", lambda d: pytest.fail("keychain read without the lock"))
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("probed while another process holds the lock"))
    child = _hold_lock()
    try:
        started = time.monotonic()
        assert usage.refresh([account], budget=0.3) == {account: stale}
        assert time.monotonic() - started < 2
    finally:
        child.communicate(timeout=5)


CONCURRENT = """
import json, sys, time
from pathlib import Path
from shiftover import config, usage
log, go = Path(sys.argv[1]), Path(sys.argv[2])
usage.claude.access_token = lambda d: "fake-" + Path(d).name

def fetch(tok):
    with log.open("a") as f:
        f.write(tok + "\\n")
    time.sleep(0.4)
    return {"five_hour": {"utilization": 12}}, None, None

usage.fetch = fetch
print("ready", flush=True)
while not go.exists():
    time.sleep(0.005)
out = usage.refresh([a.path for a in config.load().ordered()])
print(json.dumps(sorted(k for k, e in out.items() if e.get("limits") and not e.get("err"))))
"""


def test_concurrent_refreshes_in_separate_processes_fetch_each_account_once(home, tmp_path):
    log, go = tmp_path / "fetches.log", tmp_path / "go"
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    children = [subprocess.Popen([sys.executable, "-c", CONCURRENT, str(log), str(go)], env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(6)]
    try:
        for c in children:
            assert c.stdout.readline().strip() == "ready", c.stderr.read()
        go.touch()
        outs = [c.communicate(timeout=30) for c in children]
    finally:
        for c in children:
            c.kill()
    keys = sorted(str(usage.claude.norm(d)) for d in (home / ".claude", home / ".claude-second", home / ".claude-third"))
    assert all(json.loads(out) == keys for out, _ in outs), outs
    assert sorted(log.read_text().split()) == ["fake-.claude", "fake-.claude-second", "fake-.claude-third"]


def test_background_refresh_only_probes_stale_accounts(account, monkeypatch):
    other = str(usage.claude.norm(account + "-second"))
    entry = {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("test"), "limits": []}
    paths.write_json(usage.cache_path(), {account: entry, other: {**entry, "ts": 600}})
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or ({}, None, None))
    entries = usage.refresh_stale([account, other])
    assert entries[account] == entry
    assert entries[other]["ts"] == 1000
    assert seen == ["test"]


def test_refresh_reads_cache_again_after_token_lookup(account, monkeypatch):
    paths.write_json(usage.cache_path(), {account: {"ts": 0}})
    entry = {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("test"), "limits": []}

    def token(d):
        paths.write_json(usage.cache_path(), {account: entry})
        return "test"

    monkeypatch.setattr(usage.claude, "access_token", token)
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("fresh entry probed"))
    assert usage.refresh([account])[account] == entry


@pytest.mark.parametrize("force", [False, True])
def test_429_retry_at_is_honoured_even_under_force(account, monkeypatch, force):
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or (None, "HTTP 429", "3493"))
    entry = usage.refresh([account])[account]
    assert entry["retry_at"] == 4493
    assert entry["err"] == "HTTP 429"
    monkeypatch.setattr(usage.time, "time", lambda: 4492)
    assert usage.refresh([account], ttl=0, force=force)[account] == entry
    assert seen == ["test"]
    monkeypatch.setattr(usage.time, "time", lambda: 4493)
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or ({}, None, None))
    assert "retry_at" not in usage.refresh([account])[account]
    assert seen == ["test", "test"]


@pytest.mark.parametrize("err", ["HTTP 429", "HTTP 401", "HTTP 503", "no token (allow keychain access)",
                                 usage.RENEWING, usage.LOGIN_REQUIRED])
def test_token_change_invalidates_failing_entries_and_backoff(account, monkeypatch, err):
    entry = {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("old"), "err": err}
    if err == "HTTP 429":
        entry["retry_at"] = 7000
    if err == usage.LOGIN_REQUIRED:
        entry["renew_at"] = 1000
    if err.startswith("no token"):
        entry["token_fp"] = ""
    paths.write_json(usage.cache_path(), {account: entry})
    lookups, probes = [], []
    monkeypatch.setattr(usage.claude, "access_token", lambda d: lookups.append(d) or "new")
    monkeypatch.setattr(usage, "fetch", lambda tok: probes.append(tok) or ({}, None, None))
    result = usage.refresh([account])[account]
    assert result["token_fp"] == usage.fingerprint("new")
    assert len(result["token_fp"]) == 12
    assert "err" not in result and "retry_at" not in result
    assert lookups == [account] and probes == ["new"]
    assert paths.read_json(usage.cache_path())[account] == result


def test_fresh_good_entries_skip_the_keychain(account, monkeypatch):
    entry = {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("old"), "limits": []}
    paths.write_json(usage.cache_path(), {account: entry})
    lookups, probes = [], []
    monkeypatch.setattr(usage.claude, "access_token", lambda d: lookups.append(d) or "new")
    monkeypatch.setattr(usage, "fetch", lambda tok: probes.append(tok) or ({}, None, None))
    assert usage.refresh([account])[account] == entry
    assert lookups == [] and probes == []
    # Once the TTL runs out the new token is read and used.
    monkeypatch.setattr(usage.time, "time", lambda: 1300)
    assert usage.refresh([account])[account]["token_fp"] == usage.fingerprint("new")
    assert lookups == [account] and probes == ["new"]


@pytest.mark.parametrize("cached", [
    {"limits": []},
    {"err": "HTTP 503"},
    {"err": "HTTP 429", "retry_at": 4000},
])
def test_an_unreadable_token_never_invalidates_an_entry(account, monkeypatch, cached):
    entry = {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("test"), **cached}
    paths.write_json(usage.cache_path(), {account: entry})
    monkeypatch.setattr(usage.claude, "access_token", lambda d: "")
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("probed on an unreadable keychain"))
    assert usage.refresh([account])[account] == entry
    assert paths.read_json(usage.cache_path())[account] == entry


def test_legacy_cache_without_a_fingerprint_is_invalidated(account, monkeypatch):
    paths.write_json(usage.cache_path(), {account: {"ts": 1000, "email": "one@example.com", "err": "HTTP 429"}})
    monkeypatch.setattr(usage, "fetch", lambda tok: ({}, None, None))
    assert usage.refresh([account])[account]["token_fp"] == usage.fingerprint("test")


@pytest.mark.parametrize("err", ["timeout", "URLError", "HTTP 500", "HTTP 503"])
def test_errors_expire_after_60_seconds(account, monkeypatch, err):
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or (None, err, None))
    entry = usage.refresh([account])[account]
    monkeypatch.setattr(usage.time, "time", lambda: 1059)
    assert usage.fresh(entry) and usage.refresh([account])[account] == entry
    assert seen == ["test"]
    monkeypatch.setattr(usage.time, "time", lambda: 1060)
    assert not usage.fresh(entry)
    assert usage.refresh([account])[account]["ts"] == 1060
    assert seen == ["test", "test"]


def test_success_ttl_and_explicit_force(account, monkeypatch):
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or ({}, None, None))
    entry = usage.refresh([account])[account]
    monkeypatch.setattr(usage.time, "time", lambda: 1060)
    assert usage.refresh([account])[account] == entry
    assert usage.refresh([account], force=True)[account]["ts"] == 1060
    assert seen == ["test", "test"]
    monkeypatch.setattr(usage.time, "time", lambda: 1360)
    usage.refresh([account])
    assert seen == ["test", "test", "test"]


def test_force_ignores_a_future_cache_timestamp(account, monkeypatch):
    paths.write_json(usage.cache_path(), {account: {"ts": 2000, "token_fp": usage.fingerprint("test"), "limits": []}})
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or ({}, None, None))
    assert usage.refresh([account], force=True)[account]["ts"] == 1000
    assert seen == ["test"]


def _all_probes_time_out(monkeypatch):
    class Pending:
        def result(self, timeout):
            assert timeout <= 0.1
            raise concurrent.futures.TimeoutError

    class Executor:
        def __init__(self, max_workers):
            pass

        def submit(self, fn, *args):
            return Pending()

        def shutdown(self, wait, cancel_futures):
            pass

    monkeypatch.setattr(usage.concurrent.futures, "ThreadPoolExecutor", Executor)


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("cooling", [False, True])
def test_lookup_timeout_preserves_cached_backoff(account, monkeypatch, cooling, force):
    entry = {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("test")}
    if cooling:
        entry.update(err="HTTP 429", retry_at=4000)
    paths.write_json(usage.cache_path(), {account: entry})
    _all_probes_time_out(monkeypatch)
    # A slow keychain or network never turns an entry that is still good to use into "timeout".
    assert usage.refresh([account], force=force, budget=0)[account] == entry
    assert paths.read_json(usage.cache_path())[account] == entry


def test_a_stale_entry_times_out_with_its_last_limits(account, monkeypatch):
    lims = [{"kind": "session", "model": "", "used": 100.0, "resets_at": None}]
    entry = {"ts": 600, "email": "one@example.com", "token_fp": usage.fingerprint("test"), "limits": lims, "extra": "x"}
    paths.write_json(usage.cache_path(), {account: entry})
    _all_probes_time_out(monkeypatch)
    result = usage.refresh([account], budget=0)[account]
    assert result == {"ts": 1000, "email": "one@example.com", "token_fp": entry["token_fp"], "err": "timeout",
                      "limits": lims, "extra": "x", "limits_ts": 600}
    monkeypatch.setattr(usage.time, "time", lambda: 1060)
    assert usage.refresh([account], budget=0)[account]["limits_ts"] == 600


@pytest.mark.parametrize("value, expected", [("3493", 3493), (" 42 ", 42), ("0", 0), ("7201", 7200),
                                           (None, 600), ("", 600), ("bad", 600), ("-1", 600), ("1.5", 600)])
def test_retry_after_parsing_default_and_cap(account, monkeypatch, value, expected):
    monkeypatch.setattr(usage, "fetch", lambda tok: (None, "HTTP 429", value))
    assert usage.refresh([account])[account]["retry_at"] == 1000 + expected


@pytest.mark.parametrize("code, retry", [(429, "3493"), (429, None), (401, None), (503, None)])
def test_fetch_surfaces_retry_after(monkeypatch, code, retry):
    def open_url(req, timeout):
        raise urllib.error.HTTPError(usage.USAGE_URL, code, "error", {"Retry-After": retry} if retry else {}, None)

    monkeypatch.setattr(usage.urllib.request, "urlopen", open_url)
    assert usage.fetch("test") == (None, f"HTTP {code}", retry)


def test_fetch_success(monkeypatch):
    monkeypatch.setattr(usage.urllib.request, "urlopen", lambda req, timeout: io.BytesIO(b'{"five_hour": {"utilization": 12}}'))
    assert usage.fetch("test") == ({"five_hour": {"utilization": 12}}, None, None)


@pytest.mark.parametrize("failure", [TimeoutError(), urllib.error.URLError("offline")])
def test_fetch_network_errors(monkeypatch, failure):
    def open_url(req, timeout):
        raise failure

    monkeypatch.setattr(usage.urllib.request, "urlopen", open_url)
    assert usage.fetch("test") == (None, type(failure).__name__, None)


@pytest.mark.parametrize("failure, later", [((None, "HTTP 429", "60"), 1060), ((None, "TimeoutError", None), 1060)])
def test_429_and_timeouts_keep_the_last_limits(account, monkeypatch, failure, later):
    lims = [{"kind": "session", "model": "", "used": 100.0, "resets_at": None}]
    paths.write_json(usage.cache_path(), {account: {"ts": 600, "email": "one@example.com", "token_fp": usage.fingerprint("test"),
                                                    "limits": lims, "extra": ""}})
    monkeypatch.setattr(usage, "fetch", lambda tok: failure)
    entry = usage.refresh([account])[account]
    assert entry["err"] == failure[1] and entry["ts"] == 1000
    assert entry["limits"] == lims and entry["extra"] == "" and entry["limits_ts"] == 600
    # Failing again keeps the time the limits were actually read.
    monkeypatch.setattr(usage.time, "time", lambda: later)
    assert usage.refresh([account])[account]["ts"] == later
    assert usage.load_cache()[account]["limits_ts"] == 600


@pytest.mark.parametrize("failure", [(None, "URLError", None), (None, "HTTP 503", None)])
def test_other_failures_and_account_switches_drop_the_limits(account, monkeypatch, failure):
    prev = {"ts": 600, "email": "one@example.com", "token_fp": usage.fingerprint("test"), "limits": []}
    paths.write_json(usage.cache_path(), {account: prev})
    monkeypatch.setattr(usage, "fetch", lambda tok: failure)
    assert "limits" not in usage.refresh([account])[account]
    paths.write_json(usage.cache_path(), {account: {**prev, "email": "someone-else@example.com"}})
    monkeypatch.setattr(usage, "fetch", lambda tok: (None, "HTTP 429", "60"))
    assert "limits" not in usage.refresh([account])[account]


@pytest.mark.parametrize("token, failure", [("test", (None, "HTTP 401", None)), ("", None)])
def test_bad_token_entries_wait_the_full_ttl(account, monkeypatch, token, failure):
    # Renewed a moment ago: a refused token now waits for a login.
    paths.write_json(usage.cache_path(), {account: {"ts": 600, "email": "one@example.com", "token_fp": "", "renew_at": 900,
                                                    "limits": []}})
    seen = []
    monkeypatch.setattr(usage.claude, "access_token", lambda d: token)
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or failure)
    entry = usage.refresh([account])[account]
    assert entry["err"] == (usage.LOGIN_REQUIRED if token else "no token (allow keychain access)")
    assert usage.next_refresh(entry) == 1300 and "limits" not in entry
    monkeypatch.setattr(usage.time, "time", lambda: 1299)
    assert usage.refresh([account])[account] == entry
    # A re-login is still noticed at once, by the token's fingerprint.
    monkeypatch.setattr(usage.claude, "access_token", lambda d: "relogged")
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or ({}, None, None))
    assert "err" not in usage.refresh([account])[account]
    assert seen == (["test", "relogged"] if token else ["relogged"])


def _token(value: str, expires_at: float | None):
    tok = usage.claude.Token(value)
    tok.expires_at = expires_at
    return tok


def _spawns(monkeypatch) -> list:
    """Records each detached refresh asked for, with whether the usage lock was free by then."""
    seen = []

    def spawn():
        with usage._lock() as held:
            seen.append(held)

    monkeypatch.setattr(usage, "refresh_detached", spawn)
    return seen


LIMITS = [{"kind": "session", "model": "", "used": 40.0, "resets_at": None}]
READ = {"ts": 600, "email": "one@example.com", "limits": LIMITS, "extra": ""}


@pytest.mark.parametrize("expires_at, due", [(None, False), (600, True), (1000, True), (1300, True), (1301, False)])
def test_a_token_is_due_for_renewal_five_minutes_before_it_expires(account, expires_at, due):
    assert usage.expired(_token("test", expires_at)) is due
    assert not usage.expired("test")


@pytest.mark.parametrize("lang, renewing, login", [("en", "renewing token", "login required"),
                                                  ("tr", "anahtar yenileniyor", "giriş gerekli: hesabı açıp giriş yap")])
def test_renewal_states_are_worded_in_the_ui_language(monkeypatch, lang, renewing, login):
    monkeypatch.setattr(i18n, "LANG", lang)
    assert usage.error({"err": usage.RENEWING}) == renewing
    assert usage.error({"err": usage.LOGIN_REQUIRED}) == login
    # The panel reads these as "re-login needed": a renewal under way must not look like one.
    assert not re.search(r"401|token expired", renewing, re.I)


def test_a_waiting_caller_never_renews_an_expired_token(account, monkeypatch):
    paths.write_json(usage.cache_path(), {account: {**READ, "token_fp": usage.fingerprint("test")}})
    monkeypatch.setattr(usage.claude, "access_token", lambda d: _token("test", 900))
    monkeypatch.setattr(usage.claude, "renew", lambda d: pytest.fail("renewed while a caller waits"))
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("an expired token was sent"))
    spawns = _spawns(monkeypatch)
    entry = usage.refresh([account])[account]
    assert entry == {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("test"), "err": usage.RENEWING,
                     "limits": LIMITS, "extra": "", "limits_ts": 600}
    # Asked for once the lock is free, so the background refresh does not find it taken and give up.
    assert spawns == [True] and usage.load_cache()[account] == entry
    # Served as is meanwhile; every report asks again, in case that refresh gave up all the same.
    assert usage.refresh([account])[account] == entry and spawns == [True, True]
    monkeypatch.setattr(usage.time, "time", lambda: 1060)
    assert usage.refresh([account])[account] == {**entry, "ts": 1060}


def test_a_401_with_a_valid_expiry_asks_the_background_for_a_renewal(account, monkeypatch):
    monkeypatch.setattr(usage.claude, "access_token", lambda d: _token("test", 30000))
    monkeypatch.setattr(usage.claude, "renew", lambda d: pytest.fail("renewed while a caller waits"))
    seen = []
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or (None, "HTTP 401", None))
    spawns = _spawns(monkeypatch)
    entry = usage.refresh([account])[account]
    assert entry["err"] == usage.RENEWING and "renew_at" not in entry
    assert seen == ["test"] and spawns == [True]


@pytest.mark.parametrize("clean_exit", [True, False])
def test_the_background_refresh_renews_then_reads_usage_with_the_new_token(account, monkeypatch, clean_exit):
    # Asked for by a waiting caller ten seconds ago: fresh, but due all the same.
    paths.write_json(usage.cache_path(), {account: {**READ, "ts": 990, "token_fp": usage.fingerprint("old"),
                                                    "err": usage.RENEWING, "limits_ts": 600}})
    tokens, renewals, seen = [_token("old", 900)], [], []

    def renew(d):
        renewals.append(d)
        tokens.append(_token("new", 1000 + 8 * 3600))
        # A turn on a full account fails after the token was renewed: the token decides.
        return clean_exit

    monkeypatch.setattr(usage.claude, "access_token", lambda d: tokens[-1])
    monkeypatch.setattr(usage.claude, "renew", renew)
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or ({"five_hour": {"utilization": 12}}, None, None))
    entry = usage.refresh_stale([account])[account]
    assert renewals == [account] and seen == ["new"]
    assert entry == {"ts": 1000, "email": "one@example.com", "token_fp": usage.fingerprint("new"), "renew_at": 1000,
                     "limits": [{"kind": "session", "model": "", "used": 12.0, "resets_at": None}], "extra": ""}
    assert usage.load_cache()[account] == entry


@pytest.mark.parametrize("clean_exit", [True, False])
@pytest.mark.parametrize("after", [None, _token("old", 900), _token("new", 950), _token("", None)],
                         ids=["unchanged", "same-expiry", "still-past", "gone"])
def test_a_renewal_that_does_not_move_the_expiry_ahead_means_login_required(account, monkeypatch, after, clean_exit):
    paths.write_json(usage.cache_path(), {account: {**READ, "token_fp": usage.fingerprint("old")}})
    tokens = [_token("old", 900)]

    def renew(d):
        if after is not None:
            tokens.append(after)
        return clean_exit

    monkeypatch.setattr(usage.claude, "access_token", lambda d: tokens[-1])
    monkeypatch.setattr(usage.claude, "renew", renew)
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("probed without a renewed token"))
    # The refresh token is no longer good: only a login helps, and the old windows no longer count.
    assert usage.refresh_stale([account])[account] == {"ts": 1000, "email": "one@example.com", "renew_at": 1000,
                                                       "token_fp": usage.fingerprint("old"), "err": usage.LOGIN_REQUIRED}


def test_one_renewal_per_account_per_backoff(account, monkeypatch):
    clock = [1000]
    monkeypatch.setattr(usage.time, "time", lambda: clock[0])
    monkeypatch.setattr(usage.claude, "access_token", lambda d: _token("old", 900))
    renewals = []
    monkeypatch.setattr(usage.claude, "renew", lambda d: renewals.append(clock[0]) or False)
    monkeypatch.setattr(usage, "fetch", lambda tok: pytest.fail("an expired token was sent"))
    spawns = _spawns(monkeypatch)
    assert usage.refresh_stale([account])[account]["err"] == usage.LOGIN_REQUIRED
    # Through the backoff the account stays "login required", for waiting callers and the background refresh alike.
    for now in (1300, 1600, 1899):
        clock[0] = now
        assert usage.refresh([account])[account]["err"] == usage.LOGIN_REQUIRED
        assert usage.refresh_stale([account])[account]["err"] == usage.LOGIN_REQUIRED
    assert renewals == [1000] and spawns == []
    clock[0] = 1900
    assert usage.refresh([account])[account]["err"] == usage.RENEWING and spawns == [True]
    assert usage.refresh_stale([account])[account] == {"ts": 1900, "email": "one@example.com", "renew_at": 1900,
                                                       "token_fp": usage.fingerprint("old"), "err": usage.LOGIN_REQUIRED}
    assert renewals == [1000, 1900]


@pytest.mark.parametrize("cured", [True, False])
def test_a_401_with_a_valid_expiry_renews_once(account, monkeypatch, cured):
    tokens, renewals, seen = [_token("old", 30000)], [], []

    def renew(d):
        renewals.append(d)
        tokens.append(_token("new", 40000))
        return True

    def fetch(tok):
        seen.append(tok)
        return ({"five_hour": {"utilization": 12}}, None, None) if cured and tok == "new" else (None, "HTTP 401", None)

    monkeypatch.setattr(usage.claude, "access_token", lambda d: tokens[-1])
    monkeypatch.setattr(usage.claude, "renew", renew)
    monkeypatch.setattr(usage, "fetch", fetch)
    entry = usage.refresh_stale([account])[account]
    assert renewals == [account] and seen == ["old", "new"]
    assert entry["token_fp"] == usage.fingerprint("new") and entry["renew_at"] == 1000
    assert entry.get("err") == (None if cured else usage.LOGIN_REQUIRED)
    # Refused again within the backoff: no second renewal, only a login helps.
    monkeypatch.setattr(usage.time, "time", lambda: 1300)
    monkeypatch.setattr(usage, "fetch", lambda tok: seen.append(tok) or (None, "HTTP 401", None))
    assert usage.refresh_stale([account])[account]["err"] == usage.LOGIN_REQUIRED
    assert renewals == [account] and seen == ["old", "new", "new"]
