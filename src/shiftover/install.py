"""Wires shiftover into Claude Code: hooks, status line, the MCP server, the /handoff command and the skill."""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from importlib import resources
from pathlib import Path

from . import claude, config, paths
from .config import Config

SHARED = ["CLAUDE.md", "settings.json", "settings.local.json", "agents", "commands", "skills", "hooks",
          "output-styles", "plugins", "projects"]
HOOK_EVENTS = {
    "SessionStart": ("session-start", None, 10),
    "Stop": ("stop", None, 20),
    "StopFailure": ("stop-failure", "rate_limit", 20),
    "UserPromptSubmit": ("prompt", None, 5),
}


def exe() -> str:
    found = shutil.which("shiftover")
    if found:
        return found
    argv0 = Path(sys.argv[0])
    if argv0.name == "shiftover" and argv0.exists():
        return str(argv0.absolute())
    return f"{sys.executable} -m shiftover"


class InstallError(Exception):
    pass


_OURS = re.compile(r"(?:^|[\s/])shiftover(?:\s+-m\s+shiftover)?\s+(?:hook\s+(?:session-start|stop|stop-failure|prompt)|statusline)\s*$")


def is_ours(cmd: str) -> bool:
    """Only commands shiftover itself installs; a user's `my-shiftover-audit.sh` is not ours."""
    return bool(_OURS.search(cmd.strip())) or "CL_RUN_ID" in cmd


def merge_settings(settings: dict, exe_path: str) -> tuple[dict, list[str], str | None]:
    changes: list[str] = []
    hooks = settings.setdefault("hooks", {})
    for event, (name, matcher, timeout) in HOOK_EVENTS.items():
        kept = []
        for entry in hooks.get(event, []) or []:
            inner = [h for h in entry.get("hooks", []) if not is_ours(str(h.get("command", "")))]
            if len(inner) != len(entry.get("hooks", [])):
                changes.append(f"{event}: replaced existing shiftover hook")
            if inner:
                entry = dict(entry)
                entry["hooks"] = inner
                kept.append(entry)
        ours = {"hooks": [{"type": "command", "command": f"{exe_path} hook {name}", "timeout": timeout}]}
        if matcher:
            ours["matcher"] = matcher
        kept.append(ours)
        hooks[event] = kept
        changes.append(f"{event}: shiftover hook {name}")
    previous = None
    sl = settings.get("statusLine") or {}
    cmd = str(sl.get("command", "")) if isinstance(sl, dict) else ""
    ours = f"{exe_path} statusline"
    if not cmd or not is_ours(cmd):
        previous = cmd or None
        settings["statusLine"] = {"type": "command", "command": ours}
        changes.append("statusLine: shiftover statusline" + (f" (wrapping: {cmd})" if cmd else ""))
    elif cmd != ours:
        settings["statusLine"] = {"type": "command", "command": ours}
        changes.append("statusLine: updated shiftover path")
    return settings, changes, previous


def unmerge_settings(settings: dict, restore_cmd: str) -> tuple[dict, list[str]]:
    changes: list[str] = []
    hooks = settings.get("hooks") or {}
    for event in list(hooks):
        kept = []
        for entry in hooks.get(event, []) or []:
            inner = [h for h in entry.get("hooks", []) if not is_ours(str(h.get("command", "")))]
            if inner:
                entry = dict(entry)
                entry["hooks"] = inner
                kept.append(entry)
            else:
                changes.append(f"{event}: removed shiftover hook")
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    sl = settings.get("statusLine") or {}
    if isinstance(sl, dict) and is_ours(str(sl.get("command", ""))):
        if restore_cmd:
            settings["statusLine"] = {"type": "command", "command": restore_cmd}
            changes.append(f"statusLine: restored {restore_cmd}")
        else:
            settings.pop("statusLine", None)
            changes.append("statusLine: removed")
    return settings, changes


def settings_targets(cfg: Config) -> list[Path]:
    seen, out = set(), []
    for a in cfg.ordered():
        p = claude.settings_json(a.path)
        if not p.exists() and not claude.is_default(a.path) and not a.path.exists():
            continue
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _read_settings(p: Path) -> dict:
    if not p.exists():
        return {}
    data = paths.read_json(p, None)
    if not isinstance(data, dict):
        raise InstallError(f"{p} is not valid JSON; fix or move it first, shiftover will not overwrite it")
    return data


def write_json_preserving(p: Path, data: dict) -> None:
    """Atomic replace that keeps the file's mode and never touches the parent directory's mode."""
    target = p.resolve() if p.exists() else p
    target.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o600
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _write_settings(p: Path, data: dict) -> Path | None:
    backup = None
    if p.exists():
        backup = p.with_name(f"{p.name}.bak-shiftover-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(p, backup)
        os.chmod(backup, stat.S_IMODE(p.stat().st_mode))
    write_json_preserving(p, data)
    return backup


def _mcp_registered(d) -> bool:
    return "shiftover" in claude.mcp_servers(d)


def _mcp_add(acct, exe_path: str, dry_run: bool) -> str:
    # -e is variadic, so the positionals must sit behind "--" or they are read as more KEY=VALUE pairs.
    cmd = [claude.claude_bin() or "claude", "mcp", "add", "-s", "user", "-e", f"SHIFTOVER_ACCOUNT_DIR={acct.path}",
           "--", "shiftover", *exe_path.split(" "), "mcp"]
    if dry_run:
        return "would run: " + " ".join(cmd)
    r = subprocess.run(cmd, env=claude.env_for(acct.path), capture_output=True, text=True, timeout=60)
    text = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not _mcp_registered(acct.path):
        return "failed: " + (text or f"exit {r.returncode}")
    return text or "registered"


def _mcp_remove(acct, dry_run: bool) -> str:
    cmd = [claude.claude_bin() or "claude", "mcp", "remove", "-s", "user", "shiftover"]
    if dry_run:
        return "would run: " + " ".join(cmd)
    r = subprocess.run(cmd, env=claude.env_for(acct.path), capture_output=True, text=True, timeout=60)
    return (r.stdout + r.stderr).strip() or "removed"


def _resource(rel: str) -> str:
    return (resources.files("shiftover") / "resources" / rel).read_text(encoding="utf-8")


def _file_targets(cfg: Config, sub: str) -> list[Path]:
    seen, out = set(), []
    for a in cfg.ordered():
        d = a.path / sub
        key = str(d.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def install(cfg: Config, dry_run: bool = False, with_mcp: bool = True, with_files: bool = True) -> list[str]:
    exe_path = exe()
    report: list[str] = []
    for p in settings_targets(cfg):
        data = _read_settings(p)
        data, changes, previous = merge_settings(data, exe_path)
        if previous and not cfg.statusline_wrap:
            cfg.statusline_wrap = previous
            if not dry_run:
                config.save(cfg)
            report.append(f"config: statusline.wrap = {previous}")
        report.append(f"{p}: " + "; ".join(changes))
        if not dry_run:
            backup = _write_settings(p, data)
            if backup:
                report.append(f"{p}: backup {backup}")
    if with_mcp:
        for a in cfg.ordered():
            if _mcp_registered(a.path):
                report.append(f"mcp {a.name}: already registered")
            else:
                report.append(f"mcp {a.name}: {_mcp_add(a, exe_path, dry_run)}")
    if with_files:
        for d in _file_targets(cfg, "commands"):
            target = d / "handoff.md"
            report.append(f"{target}: {'would write' if dry_run else 'written'}")
            if not dry_run:
                d.mkdir(parents=True, exist_ok=True)
                target.write_text(_resource("commands/handoff.md"), encoding="utf-8")
        for d in _file_targets(cfg, "skills"):
            target = d / "shiftover" / "SKILL.md"
            report.append(f"{target}: {'would write' if dry_run else 'written'}")
            if not dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(_resource("skills/shiftover/SKILL.md"), encoding="utf-8")
    return report


def uninstall(cfg: Config, dry_run: bool = False) -> list[str]:
    report: list[str] = []
    for p in settings_targets(cfg):
        data = _read_settings(p)
        data, changes = unmerge_settings(data, cfg.statusline_wrap)
        if changes:
            report.append(f"{p}: " + "; ".join(changes))
            if not dry_run:
                _write_settings(p, data)
    for a in cfg.ordered():
        if _mcp_registered(a.path):
            report.append(f"mcp {a.name}: {_mcp_remove(a, dry_run)}")
    for d in _file_targets(cfg, "commands"):
        f = d / "handoff.md"
        if f.exists():
            report.append(f"{f}: {'would remove' if dry_run else 'removed'}")
            if not dry_run:
                f.unlink()
    for d in _file_targets(cfg, "skills"):
        f = d / "shiftover"
        if f.exists():
            report.append(f"{f}: {'would remove' if dry_run else 'removed'}")
            if not dry_run:
                shutil.rmtree(f, ignore_errors=True)
    rc = shell_rc()
    if rc and rc.exists() and "shiftover shell-init" in rc.read_text(encoding="utf-8", errors="replace"):
        report.append(f"{rc}: {'would remove' if dry_run else 'removed'} the shiftover line")
        if not dry_run:
            remove_shell_init(rc)
    return report


def share(main_dir: Path, new_dir: Path) -> list[str]:
    out = []
    for item in SHARED:
        src, dst = main_dir / item, new_dir / item
        if dst.exists() or dst.is_symlink():
            continue
        if not src.exists():
            if item in ("projects", "skills", "commands", "agents", "hooks", "output-styles", "plugins"):
                src.mkdir(parents=True, exist_ok=True)
            else:
                continue
        dst.symlink_to(src)
        out.append(item)
    return out


def installed_state(cfg: Config) -> dict:
    state = {"hooks": {}, "statusline": {}, "mcp": {}, "commands": {}, "skills": {}}
    for p in settings_targets(cfg):
        try:
            data = _read_settings(p)
        except InstallError:
            data = {}
        hooks = data.get("hooks") or {}
        have = [ev for ev in HOOK_EVENTS if any(is_ours(str(h.get("command", ""))) and "shiftover" in str(h.get("command", ""))
                                                for e in hooks.get(ev, []) or [] for h in e.get("hooks", []))]
        state["hooks"][str(p)] = have
        sl = data.get("statusLine") or {}
        state["statusline"][str(p)] = is_ours(str(sl.get("command", ""))) if isinstance(sl, dict) else False
    for a in cfg.ordered():
        state["mcp"][a.name] = _mcp_registered(a.path)
    for d in _file_targets(cfg, "commands"):
        state["commands"][str(d)] = (d / "handoff.md").exists()
    for d in _file_targets(cfg, "skills"):
        state["skills"][str(d)] = (d / "shiftover" / "SKILL.md").exists()
    return state


SHELL_LINE = 'eval "$(shiftover shell-init)"'
SHELL_MARK = "# shiftover: route `claude` through the account pool"


def shell_wired(rc: Path | None) -> bool:
    """An uncommented shell-init line; a commented-out one does not count."""
    if not rc or not rc.exists():
        return False
    for line in rc.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if "shiftover shell-init" in s and not s.startswith("#"):
            return True
    return False


def remove_shell_init(rc: Path) -> bool:
    text = rc.read_text(encoding="utf-8")
    kept = [l for l in text.splitlines() if l.strip() != SHELL_MARK and "shiftover shell-init" not in l]
    if len(kept) == len(text.splitlines()):
        return False
    rc.write_text("\n".join(kept) + ("\n" if text.endswith("\n") else ""), encoding="utf-8")
    return True


def shell_rc() -> Path | None:
    shell = Path(os.environ.get("SHELL", "")).name
    if shell == "zsh":
        return Path.home() / ".zshrc"
    if shell == "bash":
        prof = Path.home() / ".bash_profile"
        return prof if sys.platform == "darwin" and prof.exists() else Path.home() / ".bashrc"
    return None


def ensure_shell_init(rc: Path | None = None) -> str:
    """Returns 'added', 'present' or 'unsupported'."""
    rc = rc or shell_rc()
    if rc is None:
        return "unsupported"
    try:
        text = rc.read_text(encoding="utf-8")
    except FileNotFoundError:
        text = ""
    if "shiftover shell-init" in text:
        return "present"
    with open(rc, "a", encoding="utf-8") as f:
        f.write(("" if text.endswith("\n") or not text else "\n") + SHELL_MARK + "\n" + SHELL_LINE + "\n")
    return "added"
