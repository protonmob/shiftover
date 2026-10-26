import json
import os
import signal
import stat
import sys
import threading
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
# How long a test waits for a fake claude/codex to finish. Starting a fresh script can stall in exec for 10s
# and more on a busy macOS; every wait still returns the moment the job ends.
SLOW_START = 60


@pytest.fixture(scope="session", autouse=True)
def sandbox(tmp_path_factory):
    """shiftover's config, cache and data dirs for the whole run: a test without `home`, or a thread
    outliving its test's monkeypatch, lands here and never in the real ~/.cache or ~/.config."""
    from shiftover import claude, paths
    base = tmp_path_factory.mktemp("sandbox")
    mp = pytest.MonkeyPatch()
    mp.setenv("XDG_CONFIG_HOME", str(base / ".config"))
    mp.setenv("XDG_CACHE_HOME", str(base / ".cache"))
    mp.setenv("XDG_DATA_HOME", str(base / ".local" / "share"))
    mp.setattr(paths, "HOME", base)
    # A token renewal starts the real claude binary: a test that renews replaces this guard with a fake.
    mp.setattr(claude, "renew", lambda d: pytest.fail("a test started a real token renewal"))
    yield base
    mp.undo()
    # Every test that writes shiftover state has its own `home`: anything here escaped one.
    leaked = sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file())
    assert not leaked, f"written outside a test's home: {leaked}"


def stop_jobs():
    """Kills the job processes a test left running and waits for their exit waiters to finish."""
    from shiftover.delegate import jobs
    for proc in list(jobs._procs.values()):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
    for th in threading.enumerate():
        if th.name.startswith("shiftover-job-"):
            th.join(SLOW_START)


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A fake HOME with three Claude config dirs and a shiftover config pointing at them."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(h / ".config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(h / ".cache"))
    monkeypatch.setenv("XDG_DATA_HOME", str(h / ".local" / "share"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("SHIFTOVER_ACCOUNT_DIR", raising=False)
    monkeypatch.delenv("SHIFTOVER_RUN_ID", raising=False)
    # Jobs record the chat that started them: never the real Claude Code session running the tests.
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    # Tests often run inside a real `shiftover run`: never let one signal that wrapper or inherit its account or model.
    monkeypatch.delenv("SHIFTOVER_PID", raising=False)
    monkeypatch.delenv("SHIFTOVER_ACCOUNT", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    monkeypatch.delenv("SHIFTOVER_DEPTH", raising=False)
    import shiftover.claude as c
    # Keep parent and subprocess tests off the real keychain.
    monkeypatch.setattr(c, "access_token", lambda d: "")
    bindir = h / "bin"
    bindir.mkdir()
    security = bindir / "security"
    security.write_text("#!/bin/sh\nexit 1\n")
    security.chmod(0o700)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ.get('PATH', '')}")
    monkeypatch.setattr(c, "DEFAULT_DIR", h / ".claude")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: h))
    for name, email in (("main", "one@example.com"), ("second", "two@example.com"), ("third", "three@example.com")):
        d = h / (".claude" if name == "main" else f".claude-{name}")
        d.mkdir()
        cj = (h / ".claude.json") if name == "main" else d / ".claude.json"
        cj.write_text(json.dumps({"oauthAccount": {"emailAddress": email}, "mcpServers": {}}))
        (d / "settings.json").write_text("{}")
    (h / ".config" / "shiftover").mkdir(parents=True)
    (h / ".config" / "shiftover" / "config.toml").write_text(
        'main = "main"\nthreshold = 95\nlang = "en"\n'
        '[accounts.main]\ndir = "~/.claude"\nemail = "one@example.com"\n'
        '[accounts.second]\ndir = "~/.claude-second"\nemail = "two@example.com"\n'
        '[accounts.third]\ndir = "~/.claude-third"\nemail = "three@example.com"\n'
        f'[handoff]\nmode = "auto"\n[delegate]\nwait_seconds = {SLOW_START}\n[tips]\nenabled = true\nlevels = [75, 90]\n'
        '[codex]\nenabled = false\n'
    )
    yield h
    # Before monkeypatch restores the env: a late waiter would otherwise save into another home.
    stop_jobs()


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    """A `codex` shim that prints the JSONL event stream `codex exec --json` produces."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "codex-calls.jsonl"
    shim = bindir / "codex"
    shim.write_text(f'''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read() if not sys.stdin.isatty() else ""
with open({str(log)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd(), "prompt": prompt}}) + "\\n")
if "--version" in sys.argv:
    print("codex-cli 9.9.9"); sys.exit(0)
print(json.dumps({{"type": "thread.started", "thread_id": "thread-1"}}))
print(json.dumps({{"type": "turn.started"}}))
print(json.dumps({{"type": "item.completed", "item": {{"id": "i1", "type": "agent_message", "text": "codex: " + prompt.strip()}}}}))
print(json.dumps({{"type": "turn.completed", "usage": {{"input_tokens": 10, "output_tokens": 2}}}}))
if "-o" in sys.argv:
    open(sys.argv[sys.argv.index("-o") + 1], "w").write("codex: " + prompt.strip())
''')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ.get('PATH', '')}")
    return shim


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    """A `claude` shim that records its argv/env and prints a -p JSON result."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "claude-calls.jsonl"
    shim = bindir / "claude"
    shim.write_text(f'''#!/usr/bin/env python3
import json, os, sys, time
prompt = sys.stdin.read() if not sys.stdin.isatty() else ""
with open({str(log)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd(), "prompt": prompt,
                         "env": {{k: v for k, v in os.environ.items() if k.startswith(("CLAUDE_", "SHIFTOVER_", "ANTHROPIC_"))}}}}) + "\\n")
if "--version" in sys.argv:
    print("9.9.9 (fake)"); sys.exit(0)
if "sleep" in prompt:
    time.sleep(float(prompt.split("sleep", 1)[1].split()[0]))
sid = sys.argv[sys.argv.index("--session-id") + 1] if "--session-id" in sys.argv else "resumed"
print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "duration_ms": 5, "num_turns": 1,
                   "result": "echo: " + prompt.strip(), "session_id": sid, "total_cost_usd": 0.01, "permission_denials": []}}))
''')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("SHIFTOVER_CLAUDE_BIN", str(shim))
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ.get('PATH', '')}")
    return log


def calls(log):
    return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
