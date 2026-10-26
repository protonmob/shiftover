import hashlib
import json
import signal
import subprocess

import pytest

from shiftover import claude, paths

# The real ones, kept before the fixtures swap them for fakes and guards.
ACCESS_TOKEN, RENEW = claude.access_token, claude.renew


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


def _keychain(monkeypatch, blob: str) -> list:
    """`security find-generic-password` answering blob (nothing when empty); returns the lookups made."""
    lookups = []

    def run(argv, **kw):
        lookups.append(argv)
        return subprocess.CompletedProcess(argv, 0 if blob else 44, stdout=blob, stderr="")

    monkeypatch.setattr(claude.subprocess, "run", run)
    return lookups


def _blob(**oauth) -> str:
    return json.dumps({"claudeAiOauth": {"accessToken": "tok", "refreshToken": "ref", **oauth}})


@pytest.mark.parametrize("expires_at, expected", [(1_793_000_000_000, 1_793_000_000.0), (1_793_000_000, 1_793_000_000.0),
                                                  (None, None), ("1793000000000", None), (True, None)])
def test_access_token_carries_its_expiry_from_the_same_lookup(tmp_path, monkeypatch, expires_at, expected):
    lookups = _keychain(monkeypatch, _blob(**({} if expires_at is None else {"expiresAt": expires_at})))
    tok = ACCESS_TOKEN(tmp_path)
    assert tok == "tok" and tok.expires_at == expected
    assert lookups == [["security", "find-generic-password", "-s", claude.keychain_service(tmp_path), "-w"]]


def test_access_token_falls_back_to_the_credentials_file(tmp_path, monkeypatch):
    lookups = _keychain(monkeypatch, "")
    tok = ACCESS_TOKEN(tmp_path)
    assert tok == "" and tok.expires_at is None
    (tmp_path / ".credentials.json").write_text(_blob(expiresAt=1_793_000_000_000))
    tok = ACCESS_TOKEN(tmp_path)
    assert tok == "tok" and tok.expires_at == 1_793_000_000.0 and len(lookups) == 2


@pytest.mark.parametrize("blob", ["not json", "[]", "null", '{"claudeAiOauth": []}', '{"claudeAiOauth": "x"}',
                                  '{"claudeAiOauth": {"accessToken": 7, "expiresAt": 1793000000000}}'])
def test_access_token_shrugs_off_odd_blobs(tmp_path, monkeypatch, blob):
    _keychain(monkeypatch, blob)
    tok = ACCESS_TOKEN(tmp_path)
    assert tok == "" and tok.expires_at is None


def _popen(monkeypatch, wait) -> list:
    """Popen for claude.renew: records (argv, kwargs) and each ("wait", timeout); wait(timeout) answers."""
    calls = []

    class Proc:
        pid = 4242

        def wait(self, timeout=None):
            calls.append(("wait", timeout))
            return wait(timeout)

    def popen(argv, **kw):
        calls.append((argv, kw))
        return Proc()

    monkeypatch.setattr(claude.subprocess, "Popen", popen)
    return calls


def test_renew_runs_one_quiet_turn_with_hooks_off(home, monkeypatch):
    for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
              "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "SHIFTOVER_RUN_ID", "SHIFTOVER_PID"):
        monkeypatch.setenv(k, "from-the-calling-session")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/leaked")
    monkeypatch.setenv("SHIFTOVER_TEST_KEEP", "1")
    monkeypatch.setattr(claude, "claude_bin", lambda: "/opt/claude/bin/claude")
    calls = _popen(monkeypatch, lambda timeout: 0)
    assert RENEW(home / ".claude-second") is True
    (argv, kw), waited = calls
    assert argv[:7] == ["/opt/claude/bin/claude", "-p", "ok", "--model", "haiku", "--max-turns", "1"]
    assert json.loads(argv[argv.index("--settings") + 1]) == {"disableAllHooks": True}
    # No MCP server starts: an explicit empty config, strict, its variadic list closed by the next flag.
    i = argv.index("--mcp-config")
    assert json.loads(argv[i + 1]) == {"mcpServers": {}} and argv[i + 2] == "--strict-mcp-config"
    assert "--no-session-persistence" in argv
    # Nothing is captured: output and errors go nowhere, so no token can reach a log.
    assert kw["stdin"] == kw["stdout"] == kw["stderr"] == subprocess.DEVNULL and "capture_output" not in kw
    assert kw["start_new_session"] and kw["cwd"] == str(paths.tmp_dir() / "renew") and (paths.tmp_dir() / "renew").is_dir()
    env = kw["env"]
    assert env["CLAUDE_CONFIG_DIR"] == str(home / ".claude-second") and env["SHIFTOVER_TEST_KEEP"] == "1"
    assert not [k for k in env if k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_")]
    assert not {"ANTHROPIC_API_KEY", "SHIFTOVER_RUN_ID", "SHIFTOVER_PID"} & set(env)
    assert waited == ("wait", 90) and claude.RENEW_TIMEOUT == 90


def test_renew_on_the_default_account_names_no_config_dir(home, monkeypatch):
    # CLAUDE_CONFIG_DIR=~/.claude would send claude to another keychain item and config file.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home / ".claude-second"))
    monkeypatch.setattr(claude, "claude_bin", lambda: "claude")
    calls = _popen(monkeypatch, lambda timeout: 1)
    assert RENEW(home / ".claude") is False
    assert "CLAUDE_CONFIG_DIR" not in calls[0][1]["env"]


def test_renew_kills_a_stuck_run_with_its_children(home, monkeypatch):
    monkeypatch.setattr(claude, "claude_bin", lambda: "claude")

    def wait(timeout):
        if timeout is not None:
            raise subprocess.TimeoutExpired("claude", timeout)
        return -9

    calls = _popen(monkeypatch, wait)
    killed = []
    monkeypatch.setattr(claude.os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    assert RENEW(home / ".claude-second") is False
    assert killed == [(4242, signal.SIGKILL)] and calls[1:] == [("wait", 90), ("wait", None)]


def test_renew_without_a_binary_or_a_start_fails_quietly(home, monkeypatch):
    monkeypatch.setattr(claude, "claude_bin", lambda: None)
    monkeypatch.setattr(claude.subprocess, "Popen", lambda *a, **kw: pytest.fail("started without a binary"))
    assert RENEW(home / ".claude-second") is False

    def popen(*a, **kw):
        raise FileNotFoundError("/nonexistent/claude")

    monkeypatch.setattr(claude, "claude_bin", lambda: "/nonexistent/claude")
    monkeypatch.setattr(claude.subprocess, "Popen", popen)
    assert RENEW(home / ".claude-second") is False
