import json
import os
import time

from shiftover.delegate import jobs


def test_tail_reads_only_the_end(tmp_path):
    f = tmp_path / "big.out"
    f.write_bytes(b"x" * 10_000 + b"END")
    assert jobs._tail(f, 3) == "END"
    assert len(jobs._tail(f, 100)) == 100


def test_cancel_finalizes_a_job_that_already_finished(home, fake_claude):
    from shiftover import config
    cfg = config.load()
    job = jobs.start(cfg.accounts["second"], "quick")
    deadline = time.time() + 10
    while jobs.alive(job) and time.time() < deadline:
        time.sleep(0.05)
    jobs._procs.pop(job.id, None)
    job = jobs.load(job.id)
    assert job.status == "running"
    job = jobs.cancel(job)
    assert job.status == "done" and job.result == "echo: quick"
    assert oct(os.stat(jobs._p(job.id, "out")).st_mode & 0o777) == "0o600"


def test_structured_output_wins(home, tmp_path):
    job = jobs.Job(id="j1", account="second", dir="", started=1.0)
    jobs.paths.ensure_dir(jobs.paths.jobs_dir())
    jobs._p("j1", "out").write_text(json.dumps({"type": "result", "subtype": "success", "result": "narrative",
                                                 "structured_output": {"ok": True}, "session_id": "s"}))
    jobs._p("j1", "err").write_text("")
    assert jobs.finalize(job).result == json.dumps({"ok": True})
