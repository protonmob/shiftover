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


def test_print_mode_child_starts_outside_the_outer_run(home, monkeypatch):
    from shiftover import claude, config
    monkeypatch.setenv("SHIFTOVER_RUN_ID", "outer-run")
    monkeypatch.setenv("SHIFTOVER_PID", "8793")
    monkeypatch.setattr(claude, "claude_bin", lambda: "claude")
    seen = {}

    class FakeProc:
        def __init__(self, argv, env=None, **kw):
            seen["argv"], seen["env"] = argv, env

        def wait(self, *a):
            return 0

    monkeypatch.setattr(runner.subprocess, "Popen", FakeProc)
    cfg = config.load()
    assert runner.run(cfg, cfg.accounts["second"], ["-p", "hi"], interactive=False) == 0
    assert "SHIFTOVER_RUN_ID" not in seen["env"] and "SHIFTOVER_PID" not in seen["env"]
    assert seen["env"]["SHIFTOVER_ACCOUNT"] == "second" and seen["argv"] == ["claude", "-p", "hi"]
