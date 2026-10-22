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
