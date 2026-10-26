"""Facts about how Claude Code lays out its files, so every other module agrees on them."""
import glob
import hashlib
import json
import os
import shutil
import signal
import subprocess
from pathlib import Path

from . import paths

DEFAULT_DIR = Path.home() / ".claude"
RENEW_TIMEOUT = 90
# One tiny turn makes Claude Code renew an expired access token. Hooks are off (the user's hooks pop notifications and
# shiftover's own Stop hook would run inside it), and no MCP server starts or transcript is saved.
RENEW_ARGS = ["-p", "ok", "--model", "haiku", "--max-turns", "1", "--settings", '{"disableAllHooks": true}',
              "--mcp-config", '{"mcpServers": {}}', "--strict-mcp-config", "--no-session-persistence"]
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
# A child that inherits these reports to the outer `shiftover run`: its hooks write into that run and signal its wrapper.
RUN_IDENTITY = ("SHIFTOVER_RUN_ID", "SHIFTOVER_PID")


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


def project_dir(d, cwd) -> Path:
    """The projects/ folder holding the transcripts of sessions run in cwd: its real path with every character other
    than an ASCII letter or digit turned into "-", once per UTF-16 unit as JavaScript counts them."""
    real = os.path.realpath(str(cwd))
    name = "".join(c if c.isascii() and c.isalnum() else "--" if ord(c) > 0xFFFF else "-" for c in real)
    return norm(d) / "projects" / name


def find_transcript(d, sid: str) -> Path | None:
    """Session sid's transcript, in whichever of d's project folders holds it."""
    try:
        return next((norm(d) / "projects").glob(f"*/{glob.escape(sid)}.jsonl"), None)
    except OSError:
        return None


def transcript(d, cwd, sid: str) -> Path:
    """Where session sid run in cwd keeps its transcript; a resumed session keeps the file it began in."""
    path = project_dir(d, cwd) / f"{sid}.jsonl"
    return path if path.exists() else (find_transcript(d, sid) or path)


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


def default_model(d) -> str | None:
    """The model a bare `claude` starts with: ANTHROPIC_MODEL, else the "model" key of settings.json."""
    env = os.environ.get("ANTHROPIC_MODEL")
    if env:
        return env
    data = paths.read_json(settings_json(d), {})
    model = data.get("model") if isinstance(data, dict) else None
    return model if isinstance(model, str) and model else None


class Token(str):
    """An access token that also carries its expiry: epoch seconds, None when the blob does not say."""
    expires_at: float | None = None


def _expiry(value) -> float | None:
    # Claude Code writes expiresAt in milliseconds; seconds are taken as they are.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value / 1000 if value > 1e11 else float(value)


def access_token(d) -> Token:
    """The account's OAuth access token and its expiry, from one keychain lookup (or .credentials.json)."""
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
            return Token()
    try:
        oauth = json.loads(blob).get("claudeAiOauth") or {}
    except (ValueError, AttributeError):
        return Token()
    if not isinstance(oauth, dict) or not isinstance(oauth.get("accessToken"), str):
        return Token()
    tok = Token(oauth["accessToken"])
    tok.expires_at = _expiry(oauth.get("expiresAt"))
    return tok


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
    """The environment for a claude child on account d. The interactive runner hands its own run
    identity back in through extra; every other child starts outside any run."""
    env = dict(os.environ)
    for k in AUTH_OVERRIDES + RUN_IDENTITY:
        env.pop(k, None)
    env.pop("CLAUDE_CONFIG_DIR", None)
    if not is_default(d):
        env["CLAUDE_CONFIG_DIR"] = str(norm(d))
    if extra:
        env.update(extra)
    return env


def renew_env(d) -> dict:
    """env_for(d) minus CLAUDECODE and every CLAUDE_CODE_* variable: a renewal is no child of the session that asked."""
    return {k: v for k, v in env_for(d).items() if k != "CLAUDECODE" and not k.startswith("CLAUDE_CODE_")}


def renew(d) -> bool:
    """Runs RENEW_ARGS on account d, output discarded; True if claude exited cleanly. Callers re-read the token."""
    b = claude_bin()
    if not b:
        return False
    try:
        # A fixed empty folder: Claude Code keeps per-folder records, which a fresh temp dir each time would pile up.
        cwd = paths.ensure_dir(paths.tmp_dir() / "renew")
        proc = subprocess.Popen([b, *RENEW_ARGS], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, cwd=str(cwd), env=renew_env(d), start_new_session=True)
    except OSError:
        return False
    try:
        return proc.wait(RENEW_TIMEOUT) == 0
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.wait()
        return False


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


def flag_value(args: list[str], name: str) -> str | None:
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def effective_model(args: list[str], d) -> str | None:
    """The model a launch with these args runs on: its --model, else the default it picks up."""
    return flag_value(args, "--model") or default_model(d)


def wants_print(args: list[str]) -> bool:
    return "-p" in args or "--print" in args
