from shiftover import runner


def test_resume_args_override_model_and_effort():
    flags = ["--effort", "high", "--model", "opus", "--dangerously-skip-permissions"]
    out = runner.resume_args(flags, "sid", "claude-fable-5-1", "max")
    assert out == ["--dangerously-skip-permissions", "--model", "claude-fable-5-1", "--effort", "max", "--resume", "sid"]
    assert runner.resume_args(flags, "sid", None, None) == flags + ["--resume", "sid"]
