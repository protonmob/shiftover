import json
import os
import subprocess
import sys
import threading
import time

import pytest

from shiftover import paths
from shiftover.delegate import jobs
from tests.conftest import SRC, stop_jobs


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
    assert done.wait(10)
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
    deadline = time.monotonic() + 10
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
    assert done.wait(10)
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
