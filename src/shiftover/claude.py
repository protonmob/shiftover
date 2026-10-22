"""Facts about how Claude Code lays out its files, so every other module agrees on them."""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from . import paths

DEFAULT_DIR = Path.home() / ".claude"
PASSTHROUGH = {
    "auth", "mcp", "update", "doctor", "plugin", "setup-token", "config", "install",
    "migrate-installer", "agents", "--version", "-v", "--help", "-h",
}
VALUE_FLAGS = {
    "--add-dir", "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
    "--autocompact", "--betas", "--debug-file", "--effort", "--fallback-model", "--mcp-config",
    "--model", "-n", "--name", "--permission-mode", "--plugin-dir", "--plugin-url",
    "--setting-sources", "--settings", "--system-prompt", "--system-prompt-file", "--tools",
    "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
    "--permission-prompt-tool", "--max-budget-usd", "--json-schema", "--output-format",
    "--input-format", "--file", "--environment",
}
VARIADIC_FLAGS = {"--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools",
                  "--mcp-config", "--add-dir", "--plugin-dir", "--betas"}
SESSION_SELECTORS = {"-c", "--continue", "-r", "--resume", "--session-id", "--fork-session", "-p", "--print"}
# Any of these would make claude authenticate as someone other than the directory's sign-in.
AUTH_OVERRIDES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")


def norm(d) -> Path:
    """The exact string Claude Code sees in CLAUDE_CONFIG_DIR; symlinks are kept because the
    keychain service name is a hash of this string."""
    return Path(os.path.expanduser(str(d))).absolute()


def is_default(d) -> bool:
    return norm(d) == DEFAULT_DIR


def config_json(d) -> Path:
    return Path.home() / ".claude.json" if is_default(d) else norm(d) / ".claude.json"


def settings_json(d) -> Path:
    return norm(d) / "settings.json"


def keychain_service(d) -> str:
    if is_default(d):
        return "Claude Code-credentials"
    return "Claude Code-credentials-" + hashlib.sha256(str(norm(d)).encode()).hexdigest()[:8]


def read_config_json(d) -> dict:
    return paths.read_json(config_json(d), {}) or {}


def email(d) -> str:
    return (read_config_json(d).get("oauthAccount") or {}).get("emailAddress") or ""


def mcp_servers(d) -> dict:
    return read_config_json(d).get("mcpServers") or {}


def access_token(d) -> str:
    blob = ""
    try:
        blob = subprocess.run(
            ["security", "find-generic-password", "-s", keychain_service(d), "-w"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    if not blob:
        try:
            blob = (norm(d) / ".credentials.json").read_text(encoding="utf-8")
        except OSError:
            return ""
    try:
        return json.loads(blob).get("claudeAiOauth", {}).get("accessToken") or ""
    except ValueError:
        return ""


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def live_sessions(d) -> list[dict]:
    out = []
    sdir = norm(d) / "sessions"
    try:
        files = list(sdir.glob("*.json"))
    except OSError:
        return out
    for f in files:
        s = paths.read_json(f)
        if not isinstance(s, dict) or not pid_alive(int(s.get("pid") or 0)):
            continue
        out.append({
            "pid": s.get("pid"), "session_id": s.get("sessionId"), "cwd": s.get("cwd"),
            "name": s.get("name"), "status": s.get("status"), "kind": s.get("kind"),
        })
    return out


def claude_bin() -> str | None:
    return os.environ.get("SHIFTOVER_CLAUDE_BIN") or shutil.which("claude")


def env_for(d, extra: dict | None = None) -> dict:
    env = dict(os.environ)
    for k in AUTH_OVERRIDES:
        env.pop(k, None)
    env.pop("CLAUDE_CONFIG_DIR", None)
    if not is_default(d):
        env["CLAUDE_CONFIG_DIR"] = str(norm(d))
    if extra:
        env.update(extra)
    return env


def current_dir() -> Path:
    d = os.environ.get("SHIFTOVER_ACCOUNT_DIR") or os.environ.get("CLAUDE_CONFIG_DIR")
    return norm(d) if d else DEFAULT_DIR


def version() -> str:
    b = claude_bin()
    if not b:
        return ""
    try:
        return subprocess.run([b, "--version"], capture_output=True, text=True, timeout=15).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def launch_flags(args: list[str]) -> list[str]:
    """Launch flags minus prompts and session selectors, so a resumed run keeps
    --dangerously-skip-permissions, --effort, --settings and the like."""
    out: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            break
        name, _, inline = a.partition("=") if a.startswith("--") else (a, "", "")
        if name in SESSION_SELECTORS:
            if name in ("-r", "--resume", "--session-id") and not inline and i + 1 < len(args) and not args[i + 1].startswith("-"):
                i += 1
        elif a.startswith("-"):
            out.append(a)
            if inline:
                pass
            elif name in VARIADIC_FLAGS:
                while i + 1 < len(args) and not args[i + 1].startswith("-"):
                    out.append(args[i + 1])
                    i += 1
            elif name in VALUE_FLAGS and i + 1 < len(args):
                out.append(args[i + 1])
                i += 1
        i += 1
    return out


def strip_flag(flags: list[str], name: str) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(flags):
        if flags[i] == name:
            i += 2
            continue
        if flags[i].startswith(name + "="):
            i += 1
            continue
        out.append(flags[i])
        i += 1
    return out


def wants_print(args: list[str]) -> bool:
    return "-p" in args or "--print" in args
