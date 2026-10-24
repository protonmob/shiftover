import json
import os
import stat
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A fake HOME with three Claude config dirs and a shiftover config pointing at them."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(h / ".config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(h / ".cache"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("SHIFTOVER_ACCOUNT_DIR", raising=False)
    monkeypatch.delenv("SHIFTOVER_RUN_ID", raising=False)
    # Tests often run inside a real `shiftover run`: never let one signal that wrapper or inherit its account or model.
    monkeypatch.delenv("SHIFTOVER_PID", raising=False)
    monkeypatch.delenv("SHIFTOVER_ACCOUNT", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    monkeypatch.delenv("SHIFTOVER_DEPTH", raising=False)
    import shiftover.claude as c
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
        '[handoff]\nmode = "auto"\n[delegate]\nwait_seconds = 5\n[tips]\nenabled = true\nlevels = [75, 90]\n'
        '[codex]\nenabled = false\n'
    )
    return h


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
