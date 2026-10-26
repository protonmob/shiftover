import json
import os
import subprocess
import sys

import pytest

from shiftover import paths
from tests.conftest import calls


def _server(home):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(paths.Path(__file__).resolve().parents[1] / "src")
    return subprocess.Popen([sys.executable, "-m", "shiftover", "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env, cwd=str(home))


def _rpc(proc, mid, method, params=None):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    assert line, proc.stderr.read()
    return json.loads(line)


def _seed_usage(home):
    from shiftover import config, usage
    cfg = config.load()
    cache = {}
    for a, used in zip(cfg.ordered(), (10, 90, 30)):
        cache[str(a.path)] = {"ts": 10**12, "email": a.email, "limits": [{"kind": "session", "model": "", "used": used, "resets_at": None}]}
    paths.write_json(usage.cache_path(), cache)


def test_handshake_and_tools(home, fake_claude):
    _seed_usage(home)
    p = _server(home)
    try:
        init = _rpc(p, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
        assert init["result"]["serverInfo"]["name"] == "shiftover"
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        p.stdin.flush()
        tools = _rpc(p, 2, "tools/list")["result"]["tools"]
        assert [t["name"] for t in tools] == ["accounts", "delegate", "monitor"]
        acc = json.loads(_rpc(p, 3, "tools/call", {"name": "accounts", "arguments": {}})["result"]["content"][0]["text"])
        assert [a["name"] for a in acc] == ["main", "second", "third"] and acc[0]["is_current"]
        res = _rpc(p, 4, "tools/call", {"name": "delegate", "arguments": {"prompt": "say hi", "model": "haiku", "effort": "low", "label": "t1"}})
        body = json.loads(res["result"]["content"][0]["text"])
        assert body["status"] == "done" and body["result"] == "echo: say hi" and body["account"] == "third"
        call = calls(fake_claude)[-1]
        assert call["env"]["CLAUDE_CONFIG_DIR"].endswith(".claude-third") and call["env"]["SHIFTOVER_DEPTH"] == "1"
        assert "--model" in call["argv"] and "haiku" in call["argv"] and "--effort" in call["argv"] and call["prompt"] == "say hi"
        assert "-p" in call["argv"] and "--permission-mode" in call["argv"]
        bg = json.loads(_rpc(p, 5, "tools/call", {"name": "delegate", "arguments": {"prompt": "sleep 1 then answer", "account": "second", "background": True}})["result"]["content"][0]["text"])
        assert bg["status"] == "running" and bg["account"] == "second"
        mon = json.loads(_rpc(p, 6, "tools/call", {"name": "monitor", "arguments": {"job_ids": [bg["job_id"]], "wait_seconds": 10}})["result"]["content"][0]["text"])
        assert mon[0]["status"] == "done" and mon[0]["result"].startswith("echo: sleep 1")
        err = _rpc(p, 7, "tools/call", {"name": "delegate", "arguments": {"prompt": "x", "account": "nope"}})["result"]
        assert err["isError"] and "unknown account" in err["content"][0]["text"]
        assert "error" in _rpc(p, 8, "no/such")
    finally:
        p.stdin.close()
        p.wait(5)


def test_depth_guard(home, fake_claude, monkeypatch):
    monkeypatch.setenv("SHIFTOVER_DEPTH", "1")
    _seed_usage(home)
    p = _server(home)
    try:
        res = _rpc(p, 1, "tools/call", {"name": "delegate", "arguments": {"prompt": "x"}})["result"]
        assert res["isError"] and "cannot delegate" in res["content"][0]["text"]
    finally:
        p.stdin.close()
        p.wait(5)


def test_bad_envelopes_do_not_kill_the_server(home, fake_claude):
    p = _server(home)
    try:
        for raw in ("[]", "null", '{"id": 1, "method": 7}', '{"id": 2, "method": "ping", "params": []}'):
            p.stdin.write(raw + "\n")
            p.stdin.flush()
            assert "error" in json.loads(p.stdout.readline())
        assert _rpc(p, 9, "ping")["result"] == {}
    finally:
        p.stdin.close()
        p.wait(5)


def test_delegate_always_pins_mcp_config(home, fake_claude):
    p = _server(home)
    try:
        _rpc(p, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
        _rpc(p, 2, "tools/call", {"name": "delegate", "arguments": {"prompt": "hi", "account": "second"}})
        argv = calls(fake_claude)[-1]["argv"]
        assert "--strict-mcp-config" in argv and "--mcp-config" in argv
    finally:
        p.stdin.close()
        p.wait(5)


def test_delegate_to_codex(home, fake_claude, fake_codex):
    from shiftover import config
    cfg = config.load()
    cfg.codex_enabled = True
    config.save(cfg)
    p = _server(home)
    try:
        _rpc(p, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
        acc = json.loads(_rpc(p, 2, "tools/call", {"name": "accounts", "arguments": {}})["result"]["content"][0]["text"])
        assert acc[-1]["name"] == "codex" and acc[-1]["backend"] == "codex"
        res = json.loads(_rpc(p, 3, "tools/call", {"name": "delegate", "arguments": {
            "prompt": "review it", "account": "codex", "model": "gpt-x", "effort": "high", "permission_mode": "acceptEdits",
            "allowed_tools": ["Bash"]}})["result"]["content"][0]["text"])
        assert res["status"] == "done" and res["result"] == "codex: review it" and res["backend"] == "codex"
        assert res["session_id"] == "thread-1" and "allowed_tools" in res["ignored"]
        call = json.loads(fake_codex.parent.parent.joinpath("codex-calls.jsonl").read_text().splitlines()[-1])
        argv = call["argv"]
        assert argv[:2] == ["exec", "--json"] and "-s" in argv and argv[argv.index("-s") + 1] == "workspace-write"
        assert argv[argv.index("-m") + 1] == "gpt-x" and 'model_reasoning_effort="high"' in argv and argv[-1] == "-"
    finally:
        p.stdin.close()
        p.wait(5)


def _seed_limits(home, spec):
    from shiftover import config, usage
    cfg = config.load()
    paths.write_json(usage.cache_path(), {str(cfg.accounts[n].path): {"ts": 10**12, "email": cfg.accounts[n].email, "limits": [
        {"kind": k, "model": m, "used": u, "resets_at": None} for k, m, u in lims]} for n, lims in spec.items()})


def test_accounts_show_kept_windows_with_their_error(home):
    from shiftover import config, usage
    from shiftover.delegate import mcp
    _seed_limits(home, {"second": [("session", "", 10)], "third": [("session", "", 20)]})
    cache = usage.load_cache()
    main = config.load().accounts["main"]
    cache[str(main.path)] = {"ts": 10**12, "email": main.email, "token_fp": "", "err": "HTTP 429", "retry_at": 10**13,
                             "limits": [{"kind": "session", "model": "", "used": 100, "resets_at": None}], "limits_ts": 1}
    paths.write_json(usage.cache_path(), cache)
    out = {a["name"]: a for a in mcp.Server().accounts({})}
    assert out["main"]["windows"][0]["used_percent"] == 100 and out["main"]["error"].startswith("HTTP 429")
    assert "error" not in out["second"] and out["second"]["windows"]


def test_accounts_say_a_token_is_being_renewed_and_keep_its_windows(home, monkeypatch):
    from shiftover import config, i18n, usage
    from shiftover.delegate import mcp
    monkeypatch.setattr(i18n, "LANG", "en")
    _seed_limits(home, {"second": [("session", "", 10)], "third": [("session", "", 20)]})
    cache = usage.load_cache()
    main = config.load().accounts["main"]
    cache[str(main.path)] = {"ts": 1, "email": main.email, "token_fp": "",
                             "limits": [{"kind": "session", "model": "", "used": 40, "resets_at": None}]}
    paths.write_json(usage.cache_path(), cache)
    tok = usage.claude.Token("test")
    tok.expires_at = 1.0
    monkeypatch.setattr(usage.claude, "access_token", lambda d: tok)
    monkeypatch.setattr(usage, "fetch", lambda t: pytest.fail("an expired token was sent"))
    spawned = []
    monkeypatch.setattr(usage, "refresh_detached", lambda: spawned.append(1))
    out = {a["name"]: a for a in mcp.Server().accounts({})}
    assert out["main"]["error"] == "renewing token" and out["main"]["windows"][0]["used_percent"] == 40
    assert "error" not in out["second"] and spawned == [1]


def test_auto_without_a_model_counts_the_settings_model_window(home, fake_claude):
    from shiftover.delegate import mcp
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "fable"}))
    _seed_limits(home, {"main": [("session", "", 10)],
                        "second": [("session", "", 5), ("weekly_scoped", "Fable", 100)],
                        "third": [("session", "", 30), ("weekly_scoped", "Fable", 20)]})
    out = mcp.Server().delegate({"prompt": "hi"})
    assert out["account"] == "third" and out["status"] == "done"
    assert "--model" not in calls(fake_claude)[-1]["argv"]


def test_auto_never_falls_back_to_the_calling_account(home, fake_claude):
    from shiftover.delegate import mcp
    _seed_limits(home, {"main": [("session", "", 10)], "second": [("session", "", 100)], "third": [("session", "", 100)]})
    srv = mcp.Server()
    with pytest.raises(mcp.ToolError, match='pass account="self"'):
        srv.delegate({"prompt": "x"})
    assert calls(fake_claude) == []
    out = srv.delegate({"prompt": "hi", "account": "self"})
    assert out["account"] == "main" and out["result"] == "echo: hi"
    desc = next(t for t in mcp.TOOLS if t["name"] == "delegate")["inputSchema"]["properties"]["account"]["description"]
    assert "never the current one" in desc
