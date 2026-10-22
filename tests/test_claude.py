import hashlib

from shiftover import claude


def test_keychain_service_and_paths(home):
    assert claude.keychain_service("~/.claude") == "Claude Code-credentials"
    d = str(home / ".claude-second")
    assert claude.keychain_service(d) == "Claude Code-credentials-" + hashlib.sha256(d.encode()).hexdigest()[:8]
    assert claude.config_json("~/.claude") == home / ".claude.json"
    assert claude.config_json(d) == home / ".claude-second" / ".claude.json"
    assert claude.email(d) == "two@example.com"


def test_env_for(home, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/leaked")
    env = claude.env_for("~/.claude")
    assert "CLAUDE_CONFIG_DIR" not in env and "ANTHROPIC_API_KEY" not in env
    env = claude.env_for("~/.claude-second")
    assert env["CLAUDE_CONFIG_DIR"] == str(home / ".claude-second")


def test_launch_flags():
    args = ["--effort", "max", "-c", "--resume", "abc", "--model", "fable", "--dangerously-skip-permissions", "-p", "hello world", "--allowedTools", "Bash"]
    assert claude.launch_flags(args) == ["--effort", "max", "--model", "fable", "--dangerously-skip-permissions", "--allowedTools", "Bash"]
    assert claude.strip_flag(["--model", "a", "--effort", "b"], "--model") == ["--effort", "b"]
    assert claude.launch_flags(["--session-id=abc", "--resume=old", "--model=opus", "--allowedTools", "Read", "Edit", "--effort", "low"]) \
        == ["--model=opus", "--allowedTools", "Read", "Edit", "--effort", "low"]
    assert claude.launch_flags(["--mcp-config", "a.json", "b.json", "--", "prompt text"]) == ["--mcp-config", "a.json", "b.json"]
    assert claude.launch_flags(["--fork-session", "-r", "--model", "x"]) == ["--model", "x"]


def test_env_for_drops_auth_overrides(home, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-other")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "t")
    env = claude.env_for(home / ".claude-second")
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env and "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["CLAUDE_CONFIG_DIR"].endswith(".claude-second")
    assert claude.wants_print(["-p", "x"]) and not claude.wants_print(["x"])
