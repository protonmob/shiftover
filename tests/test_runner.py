from shiftover import runner


def test_resume_args_override_model_and_effort():
    flags = ["--effort", "high", "--model", "opus", "--dangerously-skip-permissions"]
    out = runner.resume_args(flags, "sid", "claude-fable-5-1", "max")
    assert out == ["--resume", "sid", "--dangerously-skip-permissions", "--model", "claude-fable-5-1", "--effort", "max"]
    assert runner.resume_args(flags, "sid", None, None) == ["--resume", "sid"] + flags


def test_transcript_visibility_decides_the_target(home):
    from shiftover import config
    cfg = config.load()
    main, second = cfg.accounts["main"], cfg.accounts["second"]
    (main.path / "projects" / "-work-x").mkdir(parents=True)
    (main.path / "projects" / "-work-x" / "sid1.jsonl").write_text("{}")
    assert runner.transcript_visible(main, "sid1") and not runner.transcript_visible(second, "sid1")
    (second.path / "projects").symlink_to(main.path / "projects")
    assert runner.transcript_visible(second, "sid1")


def test_pretrust_copies_folder_trust(home):
    import json
    from shiftover import claude, config
    cfg = config.load()
    src, dst = cfg.accounts["main"], cfg.accounts["second"]
    cj = claude.config_json(src.path)
    data = json.loads(cj.read_text())
    data["projects"] = {"/work/x": {"hasTrustDialogAccepted": True, "allowedTools": ["Bash"]}}
    cj.write_text(json.dumps(data))
    assert runner.pretrust(src, dst, "/work/x") is True
    out = json.loads(claude.config_json(dst.path).read_text())
    assert out["projects"]["/work/x"] == {"hasTrustDialogAccepted": True}
    assert out["oauthAccount"]["emailAddress"] == "two@example.com"
    assert runner.pretrust(src, dst, "/work/x") is False
    assert runner.pretrust(src, dst, "/work/other") is False
