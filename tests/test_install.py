import json

from shiftover import config, install


def test_merge_is_idempotent_and_keeps_user_hooks():
    settings = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}],
                          "SessionStart": [{"hooks": [{"type": "command", "command": "[ -n \"$CL_RUN_ID\" ] || exit 0; legacy"}]}]},
                "statusLine": {"type": "command", "command": "bash ~/mine.sh"}}
    s1, changes, prev = install.merge_settings(json.loads(json.dumps(settings)), "/usr/local/bin/shiftover")
    assert prev == "bash ~/mine.sh"
    assert s1["statusLine"]["command"] == "/usr/local/bin/shiftover statusline"
    stop_cmds = [h["command"] for e in s1["hooks"]["Stop"] for h in e["hooks"]]
    assert stop_cmds == ["say done", "/usr/local/bin/shiftover hook stop"]
    assert [h["command"] for e in s1["hooks"]["SessionStart"] for h in e["hooks"]] == ["/usr/local/bin/shiftover hook session-start"]
    assert s1["hooks"]["StopFailure"][0]["matcher"] == "rate_limit"
    s2, _, prev2 = install.merge_settings(json.loads(json.dumps(s1)), "/usr/local/bin/shiftover")
    assert s2 == s1 and prev2 is None
    s3, _ = install.unmerge_settings(json.loads(json.dumps(s2)), "bash ~/mine.sh")
    assert s3["statusLine"]["command"] == "bash ~/mine.sh"
    assert [h["command"] for e in s3["hooks"]["Stop"] for h in e["hooks"]] == ["say done"]
    assert "StopFailure" not in s3["hooks"] and "SessionStart" not in s3["hooks"]


def test_install_writes_files_and_hooks(home, fake_claude, monkeypatch):
    cfg = config.load()
    monkeypatch.setattr(install, "exe", lambda: "/opt/shiftover")
    report = install.install(cfg, with_mcp=False)
    for a in cfg.ordered():
        data = json.loads((a.path / "settings.json").read_text())
        assert data["statusLine"]["command"] == "/opt/shiftover statusline"
        assert (a.path / "commands" / "handoff.md").exists()
        assert (a.path / "skills" / "shiftover" / "SKILL.md").exists()
    assert any("written" in r for r in report)
    state = install.installed_state(cfg)
    assert all(len(v) == 4 for v in state["hooks"].values())
    install.uninstall(cfg)
    assert not (cfg.main_account().path / "commands" / "handoff.md").exists()


def test_share_symlinks(home):
    main = home / ".claude"
    new = home / ".claude-new"
    new.mkdir()
    (main / "skills").mkdir()
    linked = install.share(main, new)
    assert "skills" in linked and (new / "skills").is_symlink()
    assert (new / "projects").is_symlink() and (main / "projects").is_dir()
    assert "settings.json" in linked


def test_ensure_shell_init_is_idempotent(home):
    rc = home / ".zshrc"
    rc.write_text("export A=1")
    assert install.ensure_shell_init(rc) == "added"
    assert install.ensure_shell_init(rc) == "present"
    assert rc.read_text().count("shiftover shell-init") == 1 and rc.read_text().startswith("export A=1\n")


def test_setup_asks_only_for_main(home, fake_claude, monkeypatch, capsys):
    from shiftover import cli
    monkeypatch.setattr(install, "exe", lambda: "/opt/shiftover")
    monkeypatch.setattr(install, "_mcp_add", lambda acct, exe_path, dry_run: "Added")
    (home / ".config" / "shiftover" / "config.toml").unlink()
    rc = home / ".zshrc"
    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr("sys.stdin", type("T", (), {"isatty": staticmethod(lambda: True)})())
    monkeypatch.setattr("builtins.input", lambda prompt: "2")
    assert cli.main(["setup"]) == 0
    out = capsys.readouterr().out
    assert "I found 3 Claude Code account" in out and "`claude` opens two." in out and "backed up" in out
    cfg = config.load()
    assert cfg.main == "two" and set(cfg.accounts) == {"one", "two", "three"}
    assert "shiftover shell-init" in rc.read_text()
    assert (home / ".claude" / "commands" / "handoff.md").exists()

def test_is_ours_is_precise():
    assert install.is_ours("/opt/shiftover hook stop") and install.is_ours("/usr/bin/python3 -m shiftover statusline")
    assert install.is_ours("shiftover hook prompt")
    assert not install.is_ours("python /repo/shiftover-audit.py") and not install.is_ours("bash ~/shiftover/notify.sh hook stop")


def test_unmerge_keeps_unrelated_hooks_mentioning_shiftover():
    settings = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "python /repo/shiftover-audit.py"},
                                              {"type": "command", "command": "/opt/shiftover hook stop"}]}]},
                "statusLine": {"type": "command", "command": "/opt/shiftover statusline"}}
    out, _ = install.unmerge_settings(settings, "")
    assert [h["command"] for e in out["hooks"]["Stop"] for h in e["hooks"]] == ["python /repo/shiftover-audit.py"]
    assert "statusLine" not in out


def test_reinstall_updates_a_moved_executable():
    s1, _, _ = install.merge_settings({}, "/old/shiftover")
    s2, changes, prev = install.merge_settings(s1, "/new/shiftover")
    assert prev is None and s2["statusLine"]["command"] == "/new/shiftover statusline"
    assert all("/old/" not in h["command"] for ev in s2["hooks"].values() for e in ev for h in e["hooks"])


def test_settings_write_keeps_modes_and_refuses_garbage(home, tmp_path):
    p = home / ".claude-second" / "settings.json"
    p.chmod(0o600)
    install._write_settings(p, {"a": 1})
    assert oct(p.stat().st_mode & 0o777) == "0o600"
    bad = home / ".claude-third" / "settings.json"
    bad.write_text("{not json")
    import pytest
    with pytest.raises(install.InstallError):
        install._read_settings(bad)
    assert bad.read_text() == "{not json"


def test_uninstall_removes_the_shell_line(home):
    rc = home / ".zshrc"
    rc.write_text("export A=1\n")
    install.ensure_shell_init(rc)
    assert install.shell_wired(rc)
    assert install.remove_shell_init(rc) and rc.read_text() == "export A=1\n"
    rc.write_text('# eval "$(shiftover shell-init)"\n')
    assert not install.shell_wired(rc)


def test_remove_keeps_an_account_out_of_the_next_setup(home, fake_claude, monkeypatch, capsys):
    from shiftover import cli
    monkeypatch.setattr(install, "exe", lambda: "/opt/shiftover")
    monkeypatch.setattr(install, "_mcp_add", lambda acct, exe_path, dry_run: "Added")
    assert cli.main(["remove", "third"]) == 0
    assert cli.main(["setup", "--main", "main", "--no-shell"]) == 0
    cfg = config.load()
    assert set(cfg.accounts) == {"main", "second"} and cfg.ignore == ["~/.claude-third"]
    assert cli.main(["setup", "--main", "nope", "--no-install", "--no-shell"]) == 1
    assert "not an account" in capsys.readouterr().err


def test_setup_without_a_terminal_asks_for_main_by_flag(home, monkeypatch, capsys):
    from shiftover import cli
    (home / ".config" / "shiftover" / "config.toml").unlink()
    monkeypatch.setattr("sys.stdin", type("T", (), {"isatty": staticmethod(lambda: False)})())
    assert cli.main(["setup", "--no-install", "--no-shell"]) == 2
    assert "--main <name>" in capsys.readouterr().out


def test_setup_keeps_an_account_out_of_the_pool(home, fake_claude, monkeypatch, capsys):
    from shiftover import cli
    monkeypatch.setattr(install, "exe", lambda: "/opt/shiftover")
    monkeypatch.setattr(install, "_mcp_add", lambda acct, exe_path, dry_run: "Added")
    monkeypatch.setattr("sys.stdin", type("T", (), {"isatty": staticmethod(lambda: True)})())
    answers = iter(["1", "third"])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    assert cli.main(["setup", "--no-shell"]) == 0
    out = capsys.readouterr().out
    cfg = config.load()
    assert not cfg.accounts["third"].pool and cfg.accounts["second"].pool
    assert "third: kept separate" in out
