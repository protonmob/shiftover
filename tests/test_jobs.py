import json
import os
import subprocess
import sys
import threading
import time
import uuid

import pytest

from shiftover import claude, paths
from shiftover.delegate import jobs
from tests.conftest import SLOW_START, SRC, calls, stop_jobs


def test_tail_reads_only_the_end(tmp_path):
    f = tmp_path / "big.out"
    f.write_bytes(b"x" * 10_000 + b"END")
    assert jobs._tail(f, 3) == "END"
    assert len(jobs._tail(f, 100)) == 100


@pytest.mark.parametrize("backend", ["claude", "codex"])
@pytest.mark.parametrize("session_id", ["parent-chat", ""])
def test_exit_waiter_records_parent_and_finalizes(home, fake_claude, fake_codex, monkeypatch, backend, session_id):
    from shiftover import config
    if session_id:
        monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", session_id)
    else:
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.setattr(jobs.os, "getppid", lambda: 4321)
    done = threading.Event()
    observed = {}
    waiter = jobs._wait_for_exit

    def wait_for_exit(job, proc):
        observed.update(proc=proc, daemon=threading.current_thread().daemon, mcp_file=job.mcp_file)
        try:
            waiter(job, proc)
        finally:
            done.set()

    monkeypatch.setattr(jobs, "_wait_for_exit", wait_for_exit)
    if backend == "codex":
        job = jobs.start_codex(str(fake_codex), "quick")
    else:
        job = jobs.start(config.load().accounts["second"], "quick")
    assert done.wait(SLOW_START)
    record = json.loads(jobs._p(job.id, "json").read_text())
    assert record["parent_session_id"] == session_id and record["parent_pid"] == 4321
    assert record["status"] == "done" and record["finished"] >= record["started"] > 0
    assert record["result"] == ("codex: quick" if backend == "codex" else "echo: quick")
    assert record["num_turns"] == 1 and record["duration_ms"] is not None
    if backend == "codex":
        assert record["session_id"] == "thread-1" and record["usage"] == {"input_tokens": 10, "output_tokens": 2}
    else:
        assert record["cost_usd"] == 0.01 and record["session_id"]
        assert observed["mcp_file"] and not os.path.exists(observed["mcp_file"])
        assert record["mcp_file"] == ""
    assert observed["daemon"] and observed["proc"].returncode == 0
    assert job.id not in jobs._procs
    assert oct(os.stat(jobs._p(job.id, "out")).st_mode & 0o777) == "0o600"
    summary = jobs.summary(jobs.load(job.id))
    assert summary["parent_session_id"] == session_id and summary["parent_pid"] == 4321


@pytest.mark.parametrize("backend", ["claude", "codex"])
def test_exit_waiter_finalizes_failure(home, backend):
    if backend == "codex":
        event = {"type": "turn.failed", "error": {"message": "backend failed"}}
    else:
        event = {"type": "result", "subtype": "backend failed", "is_error": True, "result": ""}
    job = jobs.Job(id="failed", account=backend, dir="", backend=backend, cwd=str(home), started=time.time())
    jobs._launch(job, [sys.executable, "-c", f"print({json.dumps(event)!r}); raise SystemExit(1)"], dict(os.environ), "x")
    deadline = time.monotonic() + SLOW_START
    record = jobs.load(job.id)
    while record.status == "running" and time.monotonic() < deadline:
        time.sleep(0.01)
        record = jobs.load(job.id)
    assert record.status == "failed" and record.finished >= record.started
    assert record.error == "backend failed"


def test_old_job_defaults_parent_fields(home):
    jobs.paths.write_json(jobs._p("old", "json"), {"id": "old", "account": "second", "dir": ""})
    job = jobs.load("old")
    assert job.parent_session_id == "" and job.parent_pid == 0
    assert job.transcript_path == "" and job.log_path == ""


def _launched(monkeypatch):
    """Jobs run but are never finalized: the record stays as written at launch."""
    monkeypatch.setattr(jobs, "_wait_for_exit", lambda job, proc: proc.wait())


def test_a_claude_job_knows_its_session_and_transcript_from_the_start(home, fake_claude, monkeypatch):
    from shiftover import config
    _launched(monkeypatch)
    work = home / "my.app"
    work.mkdir()
    acct = config.load().accounts["second"]
    job = jobs.start(acct, "quick", cwd=str(work))
    jobs._procs[job.id].wait(SLOW_START)
    record = jobs.load(job.id)
    assert record.status == "running" and uuid.UUID(record.session_id).version == 4
    assert record.transcript_path == str(claude.project_dir(acct.path, work) / f"{record.session_id}.jsonl")
    assert record.transcript_path.startswith(str(acct.path / "projects" / "-")) and "-my-app/" in record.transcript_path
    argv = calls(fake_claude)[-1]["argv"]
    assert argv[argv.index("--session-id") + 1] == record.session_id and "--resume" not in argv


@pytest.mark.parametrize("where", ["elsewhere", "here", "nowhere"])
def test_a_resumed_job_follows_the_file_its_session_began_in(home, fake_claude, monkeypatch, where):
    from shiftover import config
    _launched(monkeypatch)
    acct = config.load().accounts["second"]
    folder = {"elsewhere": acct.path / "projects" / "-somewhere-else", "here": claude.project_dir(acct.path, home)}.get(where)
    if folder:
        folder.mkdir(parents=True)
        (folder / "abc-123.jsonl").write_text("")
    job = jobs.start(acct, "more", cwd=str(home), resume_session_id="abc-123")
    jobs._procs[job.id].wait(SLOW_START)
    record = jobs.load(job.id)
    expected = (folder or claude.project_dir(acct.path, home)) / "abc-123.jsonl"
    assert record.session_id == "abc-123" and record.transcript_path == str(expected)
    argv = calls(fake_claude)[-1]["argv"]
    assert argv[argv.index("--resume") + 1] == "abc-123" and "--session-id" not in argv


def test_a_codex_job_records_its_event_stream(home, fake_codex, monkeypatch):
    _launched(monkeypatch)
    job = jobs.start_codex(str(fake_codex), "quick")
    record = jobs.load(job.id)
    assert record.log_path == str(jobs._p(job.id, "out")) and record.transcript_path == ""


@pytest.mark.parametrize("resume", [None, "abc-123"])
def test_claude_args_warn_the_headless_delegate(resume):
    argv = jobs.build_args(model="haiku", effort="low", permission_mode="acceptEdits", allowed_tools=["Bash(npm test:*)", "Read"],
                           json_schema=None, max_budget_usd=None, resume_session_id=resume, label="t", mcp_file="m.json",
                           session_id="sid-1")
    note = argv[argv.index("--append-system-prompt") + 1]
    assert note == jobs.HEADLESS_NOTE and "exits as soon as your turn ends" in note and "background" in note
    # The variadic flag stays last: it would swallow anything after it.
    assert argv[-3:] == ["--allowedTools", "Bash(npm test:*)", "Read"]


def test_codex_args_fresh_and_resumed(tmp_path):
    from shiftover.delegate import codex
    common = dict(model="gpt-x", effort="high", cwd=tmp_path, permission_mode="acceptEdits",
                  last_message_file=tmp_path / "j.last", schema_file=None)
    fresh = codex.build_args(resume_session_id=None, **common)
    assert fresh[:2] == ["exec", "--json"] and fresh[fresh.index("-C") + 1] == str(tmp_path)
    assert fresh[fresh.index("-s") + 1] == "workspace-write" and fresh[-1] == "-"
    resumed = codex.build_args(resume_session_id="thread-1", **common)
    # `codex exec resume` rejects -C and -s: the sandbox goes in as config, the folder is the process's own.
    assert resumed[:3] == ["exec", "resume", "thread-1"] and "-C" not in resumed and "-s" not in resumed
    assert 'sandbox_mode="workspace-write"' in resumed and resumed[resumed.index('sandbox_mode="workspace-write"') - 1] == "-c"
    assert resumed[resumed.index("-o") + 1] == str(tmp_path / "j.last") and "--json" in resumed and "--skip-git-repo-check" in resumed
    assert resumed[resumed.index("-m") + 1] == "gpt-x" and 'model_reasoning_effort="high"' in resumed and resumed[-1] == "-"


def test_a_resumed_codex_job_runs_in_its_folder(home, fake_codex):
    work = home / "proj"
    work.mkdir()
    job = jobs.wait(jobs.start_codex(str(fake_codex), "again", cwd=str(work), resume_session_id="thread-1"), SLOW_START)
    assert job.status == "done" and job.result == "codex: again"
    call = json.loads(fake_codex.parent.parent.joinpath("codex-calls.jsonl").read_text().splitlines()[-1])
    assert call["argv"][:3] == ["exec", "resume", "thread-1"] and "-C" not in call["argv"]
    assert os.path.realpath(call["cwd"]) == os.path.realpath(work)


def test_finalize_gives_a_job_from_before_its_transcript(home):
    acct_dir = home / ".claude-second"
    job = jobs.Job(id="older", account="second", dir=str(acct_dir), cwd=str(home), started=1.0)
    jobs.save(job)
    jobs._p(job.id, "out").write_text(json.dumps({"type": "result", "subtype": "success", "result": "x", "session_id": "s-1"}))
    done = jobs.finalize(job)
    assert done.session_id == "s-1" and done.transcript_path == str(claude.project_dir(acct_dir, home) / "s-1.jsonl")


@pytest.mark.parametrize("backend", ["claude", "codex"])
@pytest.mark.parametrize("state,expected", [("S", True), ("Z", False), ("Z+", False)])
def test_alive_checks_process_state(monkeypatch, backend, state, expected):
    job = jobs.Job(id="zombie", account=backend, dir="", backend=backend, pid=1234)
    monkeypatch.setattr(jobs.claude, "pid_alive", lambda pid: True)

    def ps(argv, **kwargs):
        assert argv == ["ps", "-o", "stat=", "-o", "command=", "-p", "1234"]
        return subprocess.CompletedProcess(argv, 0, stdout=f"  {state} {backend} <defunct>\n")

    monkeypatch.setattr(jobs.subprocess, "run", ps)
    assert jobs.alive(job) is expected


@pytest.mark.parametrize("backend", ["claude", "codex"])
@pytest.mark.parametrize("reader", ["list", "monitor", "monitor_ids", "cancel"])
def test_stale_running_job_finalized_on_read(home, backend, reader):
    from shiftover.delegate import mcp
    job = jobs.Job(id="stale", account=backend, dir="", backend=backend, started=time.time() - 5,
                   parent_session_id="parent-chat", parent_pid=4321)
    jobs.save(job)
    if backend == "codex":
        jobs._p(job.id, "out").write_text("\n".join(json.dumps(e) for e in [
            {"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.started"},
            {"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}]))
        jobs._p(job.id, "last").write_text("answer")
    else:
        jobs._p(job.id, "out").write_text(json.dumps({"result": "answer", "total_cost_usd": 0.01, "num_turns": 1}))
    if reader == "list":
        out = jobs.summary(jobs.list_all()[0])
    elif reader == "cancel":
        out = jobs.summary(jobs.cancel(jobs.load(job.id)))
    else:
        out = mcp.Server().monitor({"job_ids": [job.id]} if reader == "monitor_ids" else {})[0]
    assert out["status"] == "done" and out["result"] == "answer"
    assert out["parent_session_id"] == "parent-chat" and out["parent_pid"] == 4321
    record = jobs.load(job.id)
    assert record.status == "done" and record.finished >= record.started
    assert record.num_turns == 1
    if backend == "codex":
        assert record.usage == {"input_tokens": 10, "output_tokens": 2}
    else:
        assert record.cost_usd == 0.01


def test_cancellation_survives_exit_waiter(home, fake_claude):
    from shiftover import config
    job = jobs.start(config.load().accounts["second"], "sleep 30 then answer")
    stale = jobs.load(job.id)
    proc = jobs._procs[job.id]
    cancelled = jobs.cancel(jobs.load(job.id))
    assert cancelled.status == "cancelled" and cancelled.finished > 0
    assert proc.returncode is not None
    assert jobs.finalize(stale).status == "cancelled"
    assert jobs.load(job.id).status == "cancelled"


def test_cancel_from_another_process_stays_cancelled(home, fake_claude, monkeypatch):
    from shiftover import config
    done = threading.Event()
    waiter = jobs._wait_for_exit

    def wait_for_exit(job, proc):
        try:
            waiter(job, proc)
        finally:
            done.set()

    monkeypatch.setattr(jobs, "_wait_for_exit", wait_for_exit)
    job = jobs.start(config.load().accounts["second"], "sleep 30 then answer")
    # This process owns the job and reaps it at once; the cancel comes from elsewhere, like a second MCP server.
    out = subprocess.run([sys.executable, "-c", "import sys; from shiftover.delegate import jobs; "
                          "print(jobs.cancel(jobs.load(sys.argv[1])).status)", job.id],
                         env={**os.environ, "PYTHONPATH": str(SRC)}, capture_output=True, text=True, timeout=30)
    assert out.stdout.strip() == "cancelled", out.stderr
    assert done.wait(SLOW_START)
    record = jobs.load(job.id)
    assert record.status == "cancelled" and record.finished > 0
    assert jobs.finalize(jobs.Job(**{**vars(record), "status": "running", "finished": 0.0})).status == "cancelled"


@pytest.mark.parametrize("backend", ["claude", "codex"])
def test_finalize_never_overwrites_a_cancel_saved_meanwhile(home, backend):
    job = jobs.Job(id="raced", account=backend, dir="", backend=backend, started=1.0)
    jobs.save(job)
    jobs._p(job.id, "out").write_text("")
    # Another process cancels after this one started reading the output.
    jobs.save(jobs.Job(**{**vars(job), "status": "cancelled"}))
    assert jobs._finalize(job).status == "cancelled"
    assert jobs.load(job.id).status == "cancelled"


def test_stop_jobs_leaves_no_waiter_and_finalizes_inside_the_temp_home(home, fake_claude):
    from shiftover import config
    job = jobs.start(config.load().accounts["second"], "sleep 30 then answer")
    stop_jobs()
    assert not [t for t in threading.enumerate() if t.name.startswith("shiftover-job-") and t.is_alive()]
    assert jobs._p(job.id, "json").is_relative_to(home)
    assert jobs.load(job.id).status == "failed" and job.id not in jobs._procs


def test_without_home_shiftover_dirs_stay_in_the_sandbox(sandbox):
    for d in (paths.config_dir(), paths.cache_dir(), paths.data_dir(), paths.jobs_dir()):
        assert d.is_relative_to(sandbox)
    assert paths.HOME == sandbox


def test_structured_output_wins(home, tmp_path):
    job = jobs.Job(id="j1", account="second", dir="", started=1.0)
    jobs.paths.ensure_dir(jobs.paths.jobs_dir())
    jobs._p("j1", "out").write_text(json.dumps({"type": "result", "subtype": "success", "result": "narrative",
                                                 "structured_output": {"ok": True}, "session_id": "s"}))
    jobs._p("j1", "err").write_text("")
    assert jobs.finalize(job).result == json.dumps({"ok": True})
