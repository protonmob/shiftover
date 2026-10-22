"""Wires shiftover into Claude Code: hooks, status line, the MCP server, the /handoff command and the skill."""
import json
import shutil
import subprocess
import sys
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


def is_ours(cmd: str) -> bool:
    return ("shiftover" in cmd and (" hook " in cmd or cmd.endswith(" statusline"))) or "CL_RUN_ID" in cmd


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
    if not cmd or not is_ours(cmd):
        previous = cmd or None
        settings["statusLine"] = {"type": "command", "command": f"{exe_path} statusline"}
        changes.append("statusLine: shiftover statusline" + (f" (wrapping: {cmd})" if cmd else ""))
    return settings, changes, previous


def unmerge_settings(settings: dict, restore_cmd: str) -> tuple[dict, list[str]]:
    changes: list[str] = []
    hooks = settings.get("hooks") or {}
    for event in list(hooks):
        kept = []
        for entry in hooks.get(event, []) or []:
            inner = [h for h in entry.get("hooks", []) if not ("shiftover" in str(h.get("command", "")))]
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
    if isinstance(sl, dict) and "shiftover" in str(sl.get("command", "")):
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
    data = paths.read_json(p, None)
    return data if isinstance(data, dict) else {}


def _write_settings(p: Path, data: dict) -> None:
    paths.ensure_dir(p.parent, 0o755)
    if p.exists():
        shutil.copy2(p, p.with_name(f"{p.name}.bak-shiftover-{time.strftime('%Y%m%d-%H%M%S')}"))
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p.resolve() if p.exists() else p)


def _mcp_registered(d) -> bool:
    return "shiftover" in claude.mcp_servers(d)


def _mcp_add(acct, exe_path: str, dry_run: bool) -> str:
    # -e is variadic, so the positionals must sit behind "--" or they are read as more KEY=VALUE pairs.
    cmd = [claude.claude_bin() or "claude", "mcp", "add", "-s", "user", "-e", f"SHIFTOVER_ACCOUNT_DIR={acct.path}",
           "--", "shiftover", *exe_path.split(" "), "mcp"]
    if dry_run:
        return "would run: " + " ".join(cmd)
    r = subprocess.run(cmd, env=claude.env_for(acct.path), capture_output=True, text=True, timeout=60)
    return (r.stdout + r.stderr).strip() or "registered"


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
            _write_settings(p, data)
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
                paths.ensure_dir(d, 0o755)
                target.write_text(_resource("commands/handoff.md"), encoding="utf-8")
        for d in _file_targets(cfg, "skills"):
            target = d / "shiftover" / "SKILL.md"
            report.append(f"{target}: {'would write' if dry_run else 'written'}")
            if not dry_run:
                paths.ensure_dir(target.parent, 0o755)
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
    return report


def share(main_dir: Path, new_dir: Path) -> list[str]:
    out = []
    for item in SHARED:
        src, dst = main_dir / item, new_dir / item
        if dst.exists() or dst.is_symlink():
            continue
        if not src.exists():
            if item in ("projects", "skills", "commands", "agents", "hooks", "output-styles", "plugins"):
                paths.ensure_dir(src, 0o755)
            else:
                continue
        dst.symlink_to(src)
        out.append(item)
    return out


def installed_state(cfg: Config) -> dict:
    state = {"hooks": {}, "statusline": {}, "mcp": {}, "commands": {}, "skills": {}}
    for p in settings_targets(cfg):
        data = _read_settings(p)
        hooks = data.get("hooks") or {}
        have = [ev for ev in HOOK_EVENTS if any(is_ours(str(h.get("command", ""))) and "shiftover" in str(h.get("command", ""))
                                                for e in hooks.get(ev, []) or [] for h in e.get("hooks", []))]
        state["hooks"][str(p)] = have
        sl = data.get("statusLine") or {}
        state["statusline"][str(p)] = "shiftover" in str(sl.get("command", "")) if isinstance(sl, dict) else False
    for a in cfg.ordered():
        state["mcp"][a.name] = _mcp_registered(a.path)
    for d in _file_targets(cfg, "commands"):
        state["commands"][str(d)] = (d / "handoff.md").exists()
    for d in _file_targets(cfg, "skills"):
        state["skills"][str(d)] = (d / "shiftover" / "SKILL.md").exists()
    return state
