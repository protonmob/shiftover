import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from . import __version__, claude, config, i18n, paths, pick, runner, ui, usage
from . import handoff as handoff_mod
from . import install as installer
from .config import Account, Config, ConfigError
from .i18n import t

Y, D, R = "\033[33m", "\033[2m", "\033[0m"


def _color(stream):
    return stream.isatty()


def _err(msg: str) -> int:
    print(f"shiftover: {msg}", file=sys.stderr)
    return 1


def _cfg(required: bool = True) -> Config | None:
    try:
        cfg = config.load()
    except ConfigError as e:
        if required:
            print("shiftover: " + (t("no_config") if str(e) == "no config" else str(e)), file=sys.stderr)
            sys.exit(1)
        return None
    i18n.set_lang(cfg.lang)
    return cfg


def _dirs(cfg: Config):
    return [a.path for a in cfg.ordered()]


def _flag_value(args: list[str], name: str) -> str | None:
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


# MARK: run

def cmd_run(args: list[str]) -> int:
    menu, quiet, spec = False, False, os.environ.get("SHIFTOVER_ACCOUNT") or None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--menu":
            menu = True
        elif a in ("-C", "--chdir") and i + 1 < len(args):
            try:
                os.chdir(os.path.expanduser(args[i + 1]))
            except OSError as e:
                return _err(f"cannot cd to {args[i + 1]}: {e}")
            i += 1
        elif a in ("-a", "--account") and i + 1 < len(args):
            spec = args[i + 1]
            i += 1
        elif a.startswith("--account="):
            spec = a.split("=", 1)[1]
        elif a == "--quiet":
            quiet = True
        elif a == "--":
            i += 1
            break
        else:
            break
        i += 1
    claude_args = args[i:]
    cfg = _cfg()
    if not claude.claude_bin():
        return _err(t("no_claude"))
    main = cfg.main_account()
    if not main:
        return _err(t("no_config"))
    if claude_args and claude_args[0] in claude.PASSTHROUGH:
        return runner.spawn(main, claude_args, interactive=False)
    interactive = sys.stdin.isatty() and sys.stdout.isatty() and not claude.wants_print(claude_args)
    family = usage.model_family(_flag_value(claude_args, "--model"))
    prefer = cfg.for_cwd(os.getcwd()) or main
    color = _color(sys.stderr)
    if menu:
        rows = pick.rows_for(cfg, usage.refresh(_dirs(cfg)))
        row, msg = pick.choose(cfg, rows, prefer=prefer.name, family=family)
        suggested = rows.index(row) if row in rows else 0
        for w in pick.warnings(cfg, rows):
            print((Y + w + R) if color else w, file=sys.stderr)
        idx = ui.menu(rows, suggested, msg, t("menu_hint"))
        if idx is None:
            ui.render(rows, sys.stderr, selected=suggested)
            print(msg, file=sys.stderr)
            idx = suggested
        if idx < 0:
            print(t("cancelled"), file=sys.stderr)
            return 1
        acct = rows[idx]["account"]
        print((D + f"→ {acct.name}" + R) if color else f"→ {acct.name}", file=sys.stderr)
    elif spec:
        acct = cfg.resolve(spec)
        if not acct:
            return _err(t("invalid_account", spec=spec))
    else:
        rows = pick.rows_for(cfg, usage.refresh(_dirs(cfg), budget=8 if interactive else 6))
        row, msg = pick.choose(cfg, rows, prefer=prefer.name, family=family)
        if not row:
            return _err(msg)
        acct = row["account"]
        for w in pick.warnings(cfg, rows):
            print((Y + w + R) if color else w, file=sys.stderr)
        if not quiet:
            tone = Y if msg.startswith("⚠") else D
            print((tone + msg + R) if color else msg, file=sys.stderr)
    return runner.run(cfg, acct, claude_args, interactive=interactive)


# MARK: status / doctor

def _rows(cfg: Config, with_usage: bool, force: bool = False):
    if with_usage:
        entries = usage.refresh(_dirs(cfg), ttl=0 if force else usage.TTL, force=force)
    else:
        entries = {str(a.path): {"email": claude.email(a.path)} for a in cfg.ordered()}
    return pick.rows_for(cfg, entries)


def cmd_status(ns) -> int:
    cfg = _cfg()
    rows = _rows(cfg, not ns.no_usage, ns.refresh)
    if ns.json:
        out = []
        for r in rows:
            d = {k: v for k, v in r.items() if k != "account"}
            if "limits" in r:
                d["headroom"] = usage.headroom(r["limits"])
            out.append(d)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0
    ui.render(rows, sys.stdout)
    for w in pick.warnings(cfg, rows):
        print((Y + w + R) if _color(sys.stdout) else w)
    return 0


def _ok(msg):
    print(f"  ✓ {msg}")


def _warn(msg):
    print(f"  ⚠ {msg}")


def cmd_doctor(ns) -> int:
    cfg = _cfg()
    problems = 0
    print(f"config: {cfg.path}  ({len(cfg.accounts)} accounts, main = {cfg.main})")
    b = claude.claude_bin()
    if b:
        _ok(f"claude: {b} ({claude.version() or 'version unknown'})")
    else:
        _warn(t("no_claude"))
        problems += 1
    rows = _rows(cfg, True)
    main = cfg.main_account()
    for r in rows:
        a = r["account"]
        if not a.path.is_dir():
            _warn(f"{a.name}: {a.dir} does not exist")
            problems += 1
            continue
        if r.get("err") and "limits" not in r:
            _warn(f"{a.name}: {r['err']}")
            problems += 1
        else:
            _ok(f"{a.name}: {r.get('email')} · {pick.summary(r)}")
        if main and a.name != main.name:
            shared = [i for i in installer.SHARED if (a.path / i).is_symlink()]
            missing = [i for i in ("projects", "settings.json", "skills", "commands") if not (a.path / i).is_symlink()]
            if missing:
                _warn(f"{a.name}: not shared with {main.name}: {', '.join(missing)}"
                      + (" (cross-account resume needs a shared projects dir)" if "projects" in missing else ""))
            elif shared:
                _ok(f"{a.name}: shares {len(shared)} items with {main.name}")
    for w in pick.warnings(cfg, rows):
        _warn(w)
        problems += 1
    st = installer.installed_state(cfg)
    for p, have in st["hooks"].items():
        missing = [e for e in installer.HOOK_EVENTS if e not in have]
        if missing:
            _warn(f"{p}: hooks missing: {', '.join(missing)} (run `shiftover install`)")
            problems += 1
        else:
            _ok(f"{p}: hooks installed")
        if not st["statusline"].get(p):
            _warn(f"{p}: status line not routed through shiftover (run `shiftover install`)")
    for name, reg in st["mcp"].items():
        (_ok if reg else _warn)(f"mcp {name}: {'registered' if reg else 'not registered (run `shiftover install`)'}")
        problems += 0 if reg else 1
    for d, have in st["commands"].items():
        (_ok if have else _warn)(f"{d}/handoff.md {'present' if have else 'missing'}")
    for d, have in st["skills"].items():
        (_ok if have else _warn)(f"{d}/shiftover/SKILL.md {'present' if have else 'missing'}")
    rc = ""
    for f in ("~/.zshrc", "~/.bashrc", "~/.bash_profile", "~/.config/fish/config.fish"):
        p = Path(os.path.expanduser(f))
        try:
            if "shiftover shell-init" in p.read_text(encoding="utf-8"):
                rc = f
                break
        except OSError:
            continue
    (_ok if rc else _warn)(f"shell: {'`claude` routed via ' + rc if rc else 'add `eval \"$(shiftover shell-init)\"` to your shell rc'}")
    print("ok" if not problems else f"{problems} problem(s)")
    return 0 if not problems else 1


# MARK: init / add / remove

def cmd_init(ns) -> int:
    path = paths.config_file()
    if path.exists() and not ns.force:
        return _err(f"{path} exists (use --force to overwrite)")
    names = {}
    for item in ns.name or []:
        if "=" not in item:
            return _err(f"--name expects DIR=NAME, got {item}")
        d, n = item.split("=", 1)
        names[d] = n
    cfg = config.import_existing(names, ns.main)
    if not cfg.accounts:
        return _err("no Claude Code config dirs found (~/.claude, ~/.claude-*)")
    if ns.lang:
        cfg.lang = ns.lang
    config.save(cfg, path)
    print(f"wrote {path}")
    for a in cfg.ordered():
        print(f"  {a.name:<12} {a.dir:<22} {a.email or t('not_logged_in')}" + ("  (main)" if a.name == cfg.main else ""))
    print("next: `shiftover setup` does the rest (or `shiftover install` + `eval \"$(shiftover shell-init)\"` by hand)")
    return 0


def cmd_setup(ns) -> int:
    path = paths.config_file()
    existing = config.load_or_none(path)
    cfg = existing or config.Config(lang=i18n.system_lang())
    i18n.set_lang(cfg.lang)
    added = config.merge_discovered(cfg)
    accts = cfg.ordered() if cfg.accounts else []
    if not accts:
        return _err(t("setup_found_none"))
    print(t("setup_found_1") if len(accts) == 1 else t("setup_found", n=len(accts)))
    print()
    name_w = max(len(a.name) for a in accts)
    email_w = max(len(a.email or t("not_logged_in")) for a in accts)
    for i, a in enumerate(accts, 1):
        tag = f"  ({t('setup_new')})" if a in added and existing else ""
        print(f"  {i}. {a.name:<{name_w}}   {(a.email or t('not_logged_in')):<{email_w}}   ({a.dir}){tag}")
    print()
    main = cfg.resolve(ns.main) if ns.main else None
    if not main:
        cur = cfg.main_account()
        default = accts.index(cur) + 1 if cur in accts else 1
        if sys.stdin.isatty() and len(accts) > 1:
            print(t("setup_ask"))
            while True:
                try:
                    raw = input(t("setup_ask_prompt", default=default)).strip()
                except EOFError:
                    raw = ""
                main = accts[default - 1] if not raw else cfg.resolve(raw)
                if main:
                    break
                print(t("setup_not_account", raw=raw))
            print()
        else:
            main = accts[default - 1]
    cfg.main = main.name
    config.save(cfg, path)
    backup = None
    if not ns.no_install:
        report = installer.install(cfg)
        backup = next((r.split("backup ", 1)[1] for r in report if "backup " in r), None)
    shell_state = None if ns.no_shell else installer.ensure_shell_init(installer.shell_rc())
    print(t("setup_done"))
    bullets = [t("setup_b_claude", main=main.name)]
    if len(accts) > 1:
        bullets += [t("setup_b_handoff", main=main.name), t("setup_b_inside")]
    bullets.append(t("setup_b_status"))
    if backup:
        bullets.append(t("setup_b_settings", backup=backup))
    for b in bullets:
        print(f"  • {b}")
    print()
    if shell_state == "unsupported":
        print(t("setup_shell_manual", line=installer.SHELL_LINE))
    if len(accts) < 2:
        print(t("setup_one_account"))
    print(t("setup_open_tab"))
    print(t("setup_more"))
    return 0


def cmd_add(ns) -> int:
    cfg = _cfg(required=False) or Config()
    name = ns.name
    if name in cfg.accounts:
        return _err(f"account {name} already exists")
    d = claude.norm(ns.dir or f"~/.claude-{name}")
    paths.ensure_dir(d, 0o755)
    main = cfg.main_account()
    if main and not ns.no_share and main.path != d:
        linked = installer.share(main.path, d)
        if linked:
            print(f"shared from {main.name}: {', '.join(linked)}")
    if not ns.no_login and not claude.email(d):
        b = claude.claude_bin()
        if not b:
            return _err(t("no_claude"))
        print(f"signing in {name} ({d}) — a browser window opens; use the account you want in this slot")
        subprocess.call([b, "auth", "login"], env=claude.env_for(d))
    home = str(Path.home())
    shown = "~" + str(d)[len(home):] if str(d).startswith(home) else str(d)
    cfg.accounts[name] = Account(name=name, dir=shown, email=ns.email or claude.email(d))
    if ns.main or not cfg.main:
        cfg.main = name
    config.save(cfg)
    print(f"added {name}: {shown} {cfg.accounts[name].email or t('not_logged_in')}")
    return 0


def cmd_remove(ns) -> int:
    cfg = _cfg()
    a = cfg.accounts.pop(ns.name, None)
    if not a:
        return _err(t("invalid_account", spec=ns.name))
    if cfg.main == ns.name:
        cfg.main = next(iter(cfg.accounts), "")
    cfg.map = {k: v for k, v in cfg.map.items() if v != ns.name}
    config.save(cfg)
    print(f"removed {ns.name} from the config (directory {a.dir} untouched)")
    return 0


# MARK: install / shell-init / map / sync-mcp

def cmd_install(ns) -> int:
    cfg = _cfg()
    for line in installer.install(cfg, dry_run=ns.dry_run, with_mcp=not ns.no_mcp, with_files=not ns.no_files):
        print(("would: " if ns.dry_run else "") + line)
    if not ns.dry_run:
        print("restart open claude sessions to pick up the hooks")
    return 0


def cmd_uninstall(ns) -> int:
    cfg = _cfg()
    for line in installer.uninstall(cfg, dry_run=ns.dry_run):
        print(("would: " if ns.dry_run else "") + line)
    return 0


def cmd_shell_init(ns) -> int:
    lines = ["# shiftover: route `claude` through the account pool",
             "if command -v shiftover >/dev/null 2>&1; then",
             '  claude() { shiftover run "$@"; }',
             '  claude-status() { shiftover status "$@"; }']
    if not ns.no_cl:
        lines.append('  cl() { if [ -n "$1" ] && [ -d "$1" ]; then local _d="$1"; shift; shiftover run --menu -C "$_d" "$@"; '
                     'else shiftover run --menu "$@"; fi; }')
    lines.append("fi")
    print("\n".join(lines))
    return 0


def cmd_map(ns) -> int:
    cfg = _cfg()
    if ns.action == "add":
        if not cfg.resolve(ns.account):
            return _err(t("invalid_account", spec=ns.account))
        cfg.map[ns.dir] = cfg.resolve(ns.account).name
        config.save(cfg)
    elif ns.action == "remove":
        if cfg.map.pop(ns.dir, None) is None:
            return _err(f"{ns.dir} is not mapped")
        config.save(cfg)
    for d, a in cfg.map.items():
        print(f"{d:<40} → {a}")
    if not cfg.map:
        print("(no directory mappings)")
    return 0


def cmd_sync_mcp(ns) -> int:
    cfg = _cfg()
    src = cfg.resolve(ns.source) if ns.source else cfg.main_account()
    if not src:
        return _err(t("invalid_account", spec=ns.source))
    servers = {k: v for k, v in claude.mcp_servers(src.path).items() if k != "shiftover"}
    if not servers:
        print(f"{src.name} has no user-scoped MCP servers in {claude.config_json(src.path)}")
        return 0
    targets = [a for a in cfg.ordered() if a.name != src.name] if ns.to in (None, "all") else [cfg.resolve(ns.to)]
    if not all(targets):
        return _err(t("invalid_account", spec=ns.to))
    for a in targets:
        if claude.live_sessions(a.path) and not ns.dry_run:
            print(f"⚠ {a.name} has live sessions; they may overwrite this change when they exit. Close them and rerun.")
        cj = claude.config_json(a.path)
        data = paths.read_json(cj, {}) or {}
        existing = data.setdefault("mcpServers", {})
        added = []
        for k, v in servers.items():
            if k in existing and not ns.overwrite:
                continue
            existing[k] = v
            added.append(k + (" (http/sse: authorize once with /mcp in that account)" if v.get("type") in ("http", "sse") or "url" in v else ""))
        if not added:
            print(f"{a.name}: nothing to add")
            continue
        print(f"{a.name}: {'would add' if ns.dry_run else 'added'} {', '.join(added)}")
        if not ns.dry_run:
            paths.ensure_dir(cj.parent, 0o755)
            tmp = cj.with_name(cj.name + ".tmp")
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            tmp.replace(cj)
    return 0


# MARK: handoff / jobs / usage

def cmd_handoff(ns) -> int:
    cfg = _cfg()
    try:
        print(handoff_mod.schedule(cfg, ns.account, ns.model, ns.effort, now=ns.now))
    except handoff_mod.HandoffError as e:
        return _err(str(e))
    return 0


def cmd_jobs(ns) -> int:
    from .delegate import jobs
    if ns.purge:
        print(f"purged {jobs.purge()} finished job(s) older than 24h")
        return 0
    if ns.cancel:
        j = jobs.load(ns.cancel)
        if not j:
            return _err(f"unknown job {ns.cancel}")
        print(json.dumps(jobs.summary(jobs.cancel(j)), indent=1, ensure_ascii=False))
        return 0
    if ns.show:
        j = jobs.load(ns.show)
        if not j:
            return _err(f"unknown job {ns.show}")
        print(json.dumps(jobs.summary(jobs.refresh(j), max_chars=1_000_000), indent=1, ensure_ascii=False))
        return 0
    rows = jobs.list_all()
    if not rows:
        print("(no delegate jobs)")
        return 0
    print(f"{'JOB':<22} {'STATUS':<10} {'ACCOUNT':<10} {'MODEL':<16} {'ELAPSED':>8}  {'COST':>7}  LABEL")
    for j in rows:
        jobs.refresh(j)
        el = (j.finished or time.time()) - j.started
        cost = f"${j.cost_usd:.2f}" if isinstance(j.cost_usd, (int, float)) else "-"
        print(f"{j.id:<22} {j.status:<10} {j.account:<10} {(j.model or '-'):<16} {el:>7.0f}s  {cost:>7}  {j.label}")
    return 0


def cmd_usage(ns) -> int:
    cfg = _cfg()
    if ns.raw:
        for a in cfg.ordered():
            tok = claude.access_token(a.path)
            data, err = usage.fetch(tok) if tok else (None, "no token")
            print(f"{a.name}: {json.dumps(data, ensure_ascii=False) if data else err}")
        return 0
    entries = usage.refresh(_dirs(cfg), force=ns.refresh, ttl=0 if ns.refresh else usage.TTL)
    if not ns.quiet:
        for a in cfg.ordered():
            e = entries.get(str(a.path)) or {}
            print(f"{a.name}: {e.get('err') or pick.summary({'limits': e.get('limits') or []})}")
    return 0


# MARK: parser

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="shiftover", description="Pool several Claude Code accounts: main first, automatic hand-off, delegate work.")
    p.add_argument("--version", action="version", version=f"shiftover {__version__}")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("run", help="open claude on the right account: shiftover run [--menu] [-a ACCOUNT] [-C DIR] [claude args...]", add_help=False)

    s = sub.add_parser("status", help="accounts and their usage windows")
    s.add_argument("--no-usage", action="store_true")
    s.add_argument("--refresh", action="store_true", help="ignore the cache")
    s.add_argument("--json", action="store_true")

    sub.add_parser("doctor", help="check accounts, sharing, hooks, MCP registration")

    s = sub.add_parser("setup", help="one-shot setup: scan accounts, ask for the main one, install, wire the shell")
    s.add_argument("--main", help="main account (skips the question)")
    s.add_argument("--no-install", action="store_true")
    s.add_argument("--no-shell", action="store_true")

    s = sub.add_parser("init", help="create the config from existing ~/.claude* dirs")
    s.add_argument("--import", dest="do_import", action="store_true", help="(default) discover existing config dirs")
    s.add_argument("--main", help="name of the main account")
    s.add_argument("--name", action="append", help="DIR=NAME to name a discovered dir (repeatable)")
    s.add_argument("--lang", choices=["en", "tr"])
    s.add_argument("--force", action="store_true")

    s = sub.add_parser("add", help="add an account dir (shares skills/settings/sessions with main, then signs in)")
    s.add_argument("name")
    s.add_argument("--dir")
    s.add_argument("--email")
    s.add_argument("--no-share", action="store_true")
    s.add_argument("--no-login", action="store_true")
    s.add_argument("--main", action="store_true")

    s = sub.add_parser("remove", help="remove an account from the config")
    s.add_argument("name")

    s = sub.add_parser("install", help="install hooks, status line, MCP server, /handoff and the skill")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--no-mcp", action="store_true")
    s.add_argument("--no-files", action="store_true")
    s = sub.add_parser("uninstall", help="undo install")
    s.add_argument("--dry-run", action="store_true")

    s = sub.add_parser("shell-init", help="print shell functions: eval \"$(shiftover shell-init)\"")
    s.add_argument("--no-cl", action="store_true")

    s = sub.add_parser("map", help="directory → account mappings")
    s.add_argument("action", nargs="?", choices=["add", "remove", "list"], default="list")
    s.add_argument("dir", nargs="?")
    s.add_argument("account", nargs="?")

    s = sub.add_parser("sync-mcp", help="copy one account's MCP server definitions to the others")
    s.add_argument("--from", dest="source")
    s.add_argument("--to", default="all")
    s.add_argument("--overwrite", action="store_true")
    s.add_argument("--dry-run", action="store_true")

    s = sub.add_parser("handoff", help="continue this conversation on another account at the end of the turn")
    s.add_argument("account", nargs="?")
    s.add_argument("--model")
    s.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    s.add_argument("--now", action="store_true")

    s = sub.add_parser("jobs", help="delegate jobs")
    s.add_argument("--show")
    s.add_argument("--cancel")
    s.add_argument("--purge", action="store_true")

    s = sub.add_parser("usage", help="refresh or dump the usage cache")
    s.add_argument("--refresh", action="store_true")
    s.add_argument("--quiet", action="store_true")
    s.add_argument("--raw", action="store_true")

    s = sub.add_parser("hook", help="(internal) Claude Code hook entry point")
    s.add_argument("event")
    sub.add_parser("statusline", help="(internal) Claude Code status line entry point")
    sub.add_parser("mcp", help="(internal) run the MCP server on stdio")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "run":
        return cmd_run(argv[1:])
    p = build_parser()
    ns = p.parse_args(argv)
    if ns.cmd == "hook":
        from . import hooks
        return hooks.main(ns.event)
    if ns.cmd == "statusline":
        from . import statusline
        return statusline.main()
    if ns.cmd == "mcp":
        from .delegate import mcp
        return mcp.serve()
    if ns.cmd == "map" and ns.action in ("add", "remove") and not ns.dir:
        p.error("map add DIR ACCOUNT / map remove DIR")
    if ns.cmd == "map" and ns.action == "add" and not ns.account:
        p.error("map add DIR ACCOUNT")
    handlers = {
        "status": cmd_status, "doctor": cmd_doctor, "init": cmd_init, "setup": cmd_setup, "add": cmd_add, "remove": cmd_remove,
        "install": cmd_install, "uninstall": cmd_uninstall, "shell-init": cmd_shell_init, "map": cmd_map,
        "sync-mcp": cmd_sync_mcp, "handoff": cmd_handoff, "jobs": cmd_jobs, "usage": cmd_usage,
    }
    if ns.cmd in handlers:
        return handlers[ns.cmd](ns)
    p.print_help()
    return 2
