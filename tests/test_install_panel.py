import glob
import json
import os
import subprocess
import tomllib
import zipfile
from pathlib import Path

from shiftover import claude, cli, config, install, paths, usage

ROOT = Path(__file__).resolve().parents[1]
BIN = "/fake/bin/claude"
PLUGIN = "shiftover-panel@shiftover"
ADD = ["plugin", "marketplace", "add"]
UPDATE = ["plugin", "marketplace", "update", "shiftover"]
INSTALL = ["plugin", "install", PLUGIN]
UNINSTALL = ["plugin", "uninstall", PLUGIN]
REMOVE = ["plugin", "marketplace", "remove", "shiftover"]


def fake_cli(monkeypatch, home, fail=lambda args, d: None):
    """Stands in for `claude plugin …`: records each call and edits the settings.json of the account it runs as.
    fail(args, dir name) may return a CompletedProcess or an exception instead."""
    monkeypatch.setattr(install, "exe", lambda: "/opt/shiftover")
    monkeypatch.setenv("SHIFTOVER_CLAUDE_BIN", BIN)
    seen = []

    def run(cmd, **kw):
        assert cmd[0] == BIN
        args, cdir = cmd[1:], kw["env"].get("CLAUDE_CONFIG_DIR")
        seen.append({"args": args, "dir": cdir, "kw": kw})
        d = Path(cdir) if cdir else home / ".claude"
        res = fail(args, d.name)
        if isinstance(res, BaseException):
            raise res
        if res is not None:
            return res
        p = d / "settings.json"
        data = json.loads(p.read_text())
        if args[:3] == ADD:
            data.setdefault("extraKnownMarketplaces", {})["shiftover"] = {"source": {"source": "directory", "path": args[3]}}
        elif args[:2] == ["plugin", "install"]:
            data.setdefault("enabledPlugins", {})[args[2]] = True
        elif args[:2] == ["plugin", "uninstall"]:
            data.get("enabledPlugins", {}).pop(args[2], None)
        elif args[:3] == ["plugin", "marketplace", "remove"]:
            data.get("extraKnownMarketplaces", {}).pop(args[3], None)
        p.write_text(json.dumps(data))
        return subprocess.CompletedProcess(cmd, 0, "done\n", "")

    monkeypatch.setattr(subprocess, "run", run)
    return seen


def _settings(home, d):
    return home / d / "settings.json"


def test_fresh_install_adds_the_marketplace_and_the_plugin_per_settings_file(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    cfg = config.load()
    report = install.install(cfg, with_mcp=False)
    mods = paths.mods_dir()
    assert mods == home / ".local" / "share" / "shiftover" / "mods"
    dirs = [None, str(home / ".claude-second"), str(home / ".claude-third")]
    assert [(c["args"], c["dir"]) for c in seen] == [(a, d) for d in dirs for a in (ADD + [str(mods)], INSTALL)]
    assert all(c["kw"]["timeout"] == 60 and c["kw"]["stdin"] is subprocess.DEVNULL and c["kw"]["capture_output"]
               and c["kw"]["text"] for c in seen)
    assert (mods / ".claude-plugin" / "marketplace.json").is_file()
    assert (mods / "shiftover-panel" / ".claude-plugin" / "plugin.json").is_file()
    p = _settings(home, ".claude")
    assert f"panel {p}: marketplace added" in report and f"panel {p}: plugin installed" in report
    panel = [i for i, r in enumerate(report) if r.startswith("panel")]
    assert report[panel[0]] == f"panel: copied to {mods}" and panel[0] > max(i for i, r in enumerate(report) if "SKILL.md" in r)
    assert not any("backup " in report[i] for i in panel)
    assert all(install.installed_state(cfg)["panel"].values())


def test_second_install_updates_the_marketplace_and_leaves_the_plugin(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    cfg = config.load()
    install.install(cfg, with_mcp=False)
    seen.clear()
    report = install.install(cfg, with_mcp=False)
    assert [c["args"] for c in seen] == [UPDATE] * 3
    p = _settings(home, ".claude-third")
    assert f"panel {p}: marketplace updated" in report and f"panel {p}: already installed and enabled" in report


def test_reinstall_replaces_an_older_copy(home, monkeypatch):
    fake_cli(monkeypatch, home)
    mods = paths.mods_dir()
    (mods / "shiftover-panel").mkdir(parents=True)
    (mods / "shiftover-panel" / "stale.ts").write_text("old")
    install.install(config.load(), with_mcp=False)
    assert not (mods / "shiftover-panel" / "stale.ts").exists()
    assert (mods / "shiftover-panel" / ".claude-plugin" / "plugin.json").is_file()
    assert os.listdir(mods.parent) == ["mods"]


def test_a_failed_copy_is_reported_and_skips_the_calls(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    mods = paths.mods_dir()
    mods.mkdir(parents=True)
    (mods / "old.ts").write_text("old")

    def broken(src, dst):
        dst.mkdir()
        raise OSError("disk full")

    monkeypatch.setattr(install, "_copy_tree", broken)
    report = install.install(config.load(), with_mcp=False)
    assert seen == [] and report[-1] == f"panel: copy to {mods} failed: disk full"
    assert (mods / "old.ts").read_text() == "old" and os.listdir(mods.parent) == ["mods"]


def test_copy_reads_a_zipped_package(tmp_path):
    z = tmp_path / "pkg.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("mods/.claude-plugin/marketplace.json", "{}")
        f.writestr("mods/shiftover-panel/hooks/hooks.json", "[]")
    with zipfile.ZipFile(z) as f:
        install._copy_tree(zipfile.Path(f) / "mods", tmp_path / "out")
    assert (tmp_path / "out" / ".claude-plugin" / "marketplace.json").read_text() == "{}"
    assert (tmp_path / "out" / "shiftover-panel" / "hooks" / "hooks.json").read_text() == "[]"


def test_accounts_sharing_a_settings_file_run_once(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    shared = _settings(home, ".claude-second")
    shared.unlink()
    shared.symlink_to(_settings(home, ".claude"))
    cfg = config.load()
    install.install(cfg, with_mcp=False)
    third = str(home / ".claude-third")
    assert [(c["args"][1], c["dir"]) for c in seen] == [("marketplace", None), ("install", None),
                                                         ("marketplace", third), ("install", third)]
    assert shared.is_symlink() and json.loads(shared.read_text())["enabledPlugins"][PLUGIN] is True
    assert install.installed_state(cfg)["panel"] == {str(_settings(home, ".claude")): True,
                                                     str(_settings(home, ".claude-third")): True}


def test_uninstall_removes_the_plugin_the_marketplace_and_the_copy(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    cfg = config.load()
    install.install(cfg, with_mcp=False)
    seen.clear()
    report = install.uninstall(cfg)
    mods = paths.mods_dir()
    dirs = [None, str(home / ".claude-second"), str(home / ".claude-third")]
    assert [(c["args"], c["dir"]) for c in seen] == [(a, d) for d in dirs for a in (UNINSTALL, REMOVE)]
    assert all(c["kw"]["timeout"] == 60 and c["kw"]["stdin"] is subprocess.DEVNULL for c in seen)
    p = _settings(home, ".claude")
    assert f"panel {p}: plugin uninstalled" in report and f"panel {p}: marketplace removed" in report
    assert not mods.exists() and f"{mods}: removed" in report
    assert not any(install.installed_state(cfg)["panel"].values())
    seen.clear()
    again = install.uninstall(cfg)
    assert seen == [] and not any(r.startswith(("panel", str(mods))) for r in again)


def test_uninstall_reports_a_failing_call_and_still_removes_the_copy(home, monkeypatch):
    seen = fake_cli(monkeypatch, home, lambda args, d: subprocess.CompletedProcess(args, 3, "", "") if args == UNINSTALL else None)
    p = _settings(home, ".claude")
    p.write_text(json.dumps({"enabledPlugins": {PLUGIN: False}, "extraKnownMarketplaces": {"shiftover": {}}}))
    paths.mods_dir().mkdir(parents=True)
    report = install.uninstall(config.load())
    assert [c["args"] for c in seen] == [UNINSTALL, REMOVE]
    assert f"panel {p}: failed: claude plugin uninstall {PLUGIN}: exit 3" in report
    assert f"panel {p}: marketplace removed" in report and not paths.mods_dir().exists()


def test_dry_run_runs_and_copies_nothing(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    cfg = config.load()
    mods, p = paths.mods_dir(), _settings(home, ".claude")
    report = install.install(cfg, dry_run=True, with_mcp=False)
    assert seen == [] and not mods.parent.exists()
    assert f"panel: would copy to {mods}" in report
    assert f"panel {p}: would run: claude plugin marketplace add {mods}" in report
    assert f"panel {p}: would run: claude plugin install {PLUGIN}" in report
    install.install(cfg, with_mcp=False)
    seen.clear()
    assert f"panel {p}: would run: claude plugin marketplace update shiftover" in install.install(cfg, dry_run=True, with_mcp=False)
    report = install.uninstall(cfg, dry_run=True)
    assert seen == [] and (mods / ".claude-plugin" / "marketplace.json").is_file()
    assert f"panel {p}: would run: claude plugin uninstall {PLUGIN}" in report
    assert f"panel {p}: would run: claude plugin marketplace remove shiftover" in report and f"{mods}: would remove" in report


def test_missing_claude_skips_the_panel(home, monkeypatch):
    seen = fake_cli(monkeypatch, home)
    monkeypatch.setattr(claude, "claude_bin", lambda: None)
    cfg = config.load()
    report = install.install(cfg, with_mcp=False)
    assert seen == [] and not paths.mods_dir().exists()
    assert "panel: skipped, claude CLI not found" in report and (home / ".claude" / "commands" / "handoff.md").exists()
    p = _settings(home, ".claude-second")
    p.write_text(json.dumps({**json.loads(p.read_text()), "enabledPlugins": {PLUGIN: True}}))
    paths.mods_dir().mkdir(parents=True)
    report = install.uninstall(cfg)
    assert seen == [] and not paths.mods_dir().exists()
    assert [r for r in report if r.startswith("panel")] == [f"panel {p}: stays registered, claude CLI not found"]


def test_a_failing_call_is_reported_and_install_goes_on(home, monkeypatch):
    def fail(args, d):
        if d == ".claude-second" and args[:3] == ADD:
            return subprocess.CompletedProcess(args, 1, "Adding marketplace…\n", "boom\n")
        if d == ".claude-second" and args == UPDATE:
            return subprocess.CompletedProcess(args, 2, "", "")
        if d == ".claude-third" and args == INSTALL:
            return subprocess.TimeoutExpired(args, 60)
        return None

    seen = fake_cli(monkeypatch, home, fail)
    cfg = config.load()
    report = install.install(cfg, with_mcp=False)
    mods = paths.mods_dir()
    second, third = _settings(home, ".claude-second"), _settings(home, ".claude-third")
    assert f"panel {second}: failed: claude plugin marketplace add {mods}: boom" in report
    assert f"panel {third}: failed: claude plugin install {PLUGIN}: timed out" in report
    assert [c["args"] for c in seen if c["dir"] == str(home / ".claude-second")] == [ADD + [str(mods)], UPDATE]
    assert install.installed_state(cfg)["panel"] == {str(_settings(home, ".claude")): True, str(second): False, str(third): False}
    assert all((a.path / "commands" / "handoff.md").exists() for a in cfg.ordered())


def test_add_refused_but_update_working_counts_as_updated(home, monkeypatch):
    seen = fake_cli(monkeypatch, home, lambda args, d: subprocess.CompletedProcess(args, 1, "", "already added") if args[:3] == ADD else None)
    report = install.install(config.load(), with_mcp=False)
    p = _settings(home, ".claude")
    assert f"panel {p}: marketplace updated" in report and f"panel {p}: plugin installed" in report
    assert [c["args"] for c in seen[:3]] == [ADD + [str(paths.mods_dir())], UPDATE, INSTALL]


def test_setup_never_reads_a_panel_line_as_the_settings_backup(home, monkeypatch, capsys):
    fake_cli(monkeypatch, home, lambda args, d: subprocess.CompletedProcess(args, 1, "", "no backup made") if args == INSTALL else None)
    monkeypatch.setattr(install, "_mcp_add", lambda acct, exe_path, dry_run: "Added")
    for d in (".claude", ".claude-second", ".claude-third"):
        _settings(home, d).unlink()
    assert cli.main(["setup", "--main", "main", "--no-shell"]) == 0
    assert "backed up" not in capsys.readouterr().out


def test_doctor_reports_the_panel_per_settings_file(home, monkeypatch, capsys):
    main, second, third = (_settings(home, d) for d in (".claude", ".claude-second", ".claude-third"))
    main.write_text(json.dumps({"enabledPlugins": {PLUGIN: True}}))
    second.write_text(json.dumps({"enabledPlugins": {PLUGIN: False}}))
    third.write_text(json.dumps({"enabledPlugins": [PLUGIN]}))
    cfg = config.load()
    assert install.installed_state(cfg)["panel"] == {str(main): True, str(second): False, str(third): False}
    paths.write_json(usage.cache_path(), {str(a.path): {"ts": 10**12, "email": a.email, "limits": []} for a in cfg.ordered()})
    monkeypatch.setattr(claude, "claude_bin", lambda: BIN)
    monkeypatch.setattr(claude, "version", lambda: "9.9.9 (fake)")

    def no_spawn(*a, **kw):
        raise AssertionError(f"doctor ran {a}")

    monkeypatch.setattr(subprocess, "run", no_spawn)
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out
    assert f"  ✓ {main}: side panel enabled\n" in out
    assert f"  ⚠ {second}: side panel not enabled (run `shiftover install`)\n" in out


def test_mods_dir_follows_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert paths.mods_dir() == tmp_path / "data" / "shiftover" / "mods"
    monkeypatch.delenv("XDG_DATA_HOME")
    assert paths.mods_dir() == paths.HOME / ".local" / "share" / "shiftover" / "mods"


def test_package_data_ships_every_resource():
    """setuptools expands package-data with glob(), which skips dot-directories such as .claude-plugin."""
    pkg = ROOT / "src" / "shiftover"
    patterns = tomllib.loads((ROOT / "pyproject.toml").read_text())["tool"]["setuptools"]["package-data"]["shiftover"]
    shipped = {Path(f) for pat in patterns for f in glob.glob(str(pkg / pat), recursive=True)}
    files = {Path(d) / f for d, _, names in os.walk(pkg / "resources") for f in names if f != ".DS_Store"}
    assert pkg / "resources" / "mods" / ".claude-plugin" / "marketplace.json" in files
    assert not files - shipped, sorted(str(f.relative_to(pkg)) for f in files - shipped)
