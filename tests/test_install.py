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
