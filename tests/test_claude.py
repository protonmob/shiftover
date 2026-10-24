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


def test_env_for_drops_an_inherited_run_identity(home, monkeypatch):
    monkeypatch.setenv("SHIFTOVER_RUN_ID", "outer-run")
    monkeypatch.setenv("SHIFTOVER_PID", "8793")
    env = claude.env_for(home / ".claude-second")
    assert "SHIFTOVER_RUN_ID" not in env and "SHIFTOVER_PID" not in env
    env = claude.env_for(home / ".claude-second", {"SHIFTOVER_RUN_ID": "inner-run", "SHIFTOVER_PID": "42"})
    assert env["SHIFTOVER_RUN_ID"] == "inner-run" and env["SHIFTOVER_PID"] == "42"


def test_default_model_prefers_the_environment_over_settings(home, monkeypatch):
    import json
    d = home / ".claude-second"
    assert claude.default_model(d) is None
    (d / "settings.json").write_text(json.dumps({"model": "fable"}))
    assert claude.default_model(d) == "fable"
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-opus-4-1")
    assert claude.default_model(d) == "claude-opus-4-1"
    monkeypatch.delenv("ANTHROPIC_MODEL")
    for bad in (json.dumps({"model": {"id": "x"}}), json.dumps(["fable"]), "not json"):
        (d / "settings.json").write_text(bad)
        assert claude.default_model(d) is None
    (d / "settings.json").unlink()
    assert claude.default_model(d) is None


def test_effective_model_takes_the_flag_first(home):
    import json
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "fable"}))
    assert claude.effective_model(["--model", "haiku", "-c"], "~/.claude") == "haiku"
    assert claude.effective_model(["--model=sonnet"], "~/.claude") == "sonnet"
    assert claude.effective_model(["--dangerously-skip-permissions"], "~/.claude") == "fable"
    assert claude.flag_value(["--effort", "max"], "--model") is None
