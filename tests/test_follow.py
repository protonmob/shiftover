import io
import json
import os

import pytest

from shiftover import claude, cli, config, i18n, paths
from shiftover.delegate import follow, jobs


def _assistant(*blocks, **extra):
    return {"type": "assistant", "isSidechain": False, "message": {"role": "assistant", "content": list(blocks)}, **extra}


def _tool(name, **inp):
    return {"type": "tool_use", "id": "toolu_1", "name": name, "input": inp}


def _text(text):
    return {"type": "text", "text": text}


def _transcript(cwd, home):
    """One line of each kind a transcript holds, steps and the lines that must stay out."""
    return [
        {"type": "user", "message": {"role": "user", "content": "the delegated prompt"}},
        _assistant(_text("Looking at the hooks first.\nThen the panel.")),
        _assistant({"type": "thinking", "thinking": "private reasoning"}),
        _assistant(_tool("Read", file_path=f"{cwd}/hooks/register.tsx")),
        {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "FILE BODY"}]}},
        _assistant(_tool("Edit", file_path=f"{cwd}/hooks/register.tsx", old_string="OLD BODY", new_string="NEW BODY")),
        _assistant(_tool("Write", file_path=f"{cwd}/notes.md", content="WRITTEN BODY")),
        _assistant(_tool("MultiEdit", file_path=f"{cwd}/a.py", edits=[])),
        _assistant(_tool("NotebookEdit", notebook_path=f"{cwd}/n.ipynb", new_source="")),
        _assistant(_tool("Grep", pattern="def follow", path="src")),
        _assistant(_tool("Glob", pattern="**/*.py")),
        _assistant(_tool("Bash", command="x" * 100, description="long")),
        _assistant(_tool("Bash", command="cat > .env <<'EOF'\nTOKEN=hidden-value\nEOF")),
        _assistant(_tool("Bash", command="curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnop' https://x")),
        _assistant(_tool("Bash", command="export OPENAI_API_KEY=sk-proj-abcdefghijklmnop")),
        _assistant(_tool("Agent", description="Review the diff", prompt="SUBAGENT PROMPT", subagent_type="general-purpose")),
        _assistant(_tool("WebFetch", url="https://example.com/private", prompt="FETCH PROMPT")),
        _assistant(_tool("Read", file_path="/etc/hosts")),
        _assistant(_tool("Read", file_path=f"{home}/elsewhere/x.txt")),
        # The request copies repeat earlier blocks, and a subagent's own steps are not this job's.
        {"type": "api-request-blob", "message": {"content": [_tool("Bash", command="REPEATED")]}},
        _assistant(_tool("Bash", command="SIDECHAIN"), isSidechain=True),
        {"type": "attachment"},
    ]


EN = [
    "› Looking at the hooks first.…",
    "reading: hooks/register.tsx",
    "editing: hooks/register.tsx",
    "editing: notes.md",
    "editing: a.py",
    "editing: n.ipynb",
    "searching: def follow",
    "searching: **/*.py",
    "command: " + "x" * 79 + "…",
    "command: cat > .env <<'EOF'…",
    "command: curl -H 'Authorization: Bearer ***' https://x",
    "command: export OPENAI_API_KEY=***",
    "subagent: Review the diff",
    "tool: WebFetch",
    "reading: /etc/hosts",
    "reading: ~/elsewhere/x.txt",
]
TR = [
    "› Looking at the hooks first.…",
    "okunuyor: hooks/register.tsx",
    "düzenleniyor: hooks/register.tsx",
    "düzenleniyor: notes.md",
    "düzenleniyor: a.py",
    "düzenleniyor: n.ipynb",
    "aranıyor: def follow",
    "aranıyor: **/*.py",
    "komut: " + "x" * 79 + "…",
    "komut: cat > .env <<'EOF'…",
    "komut: curl -H 'Authorization: Bearer ***' https://x",
    "komut: export OPENAI_API_KEY=***",
    "alt ajan: Review the diff",
    "araç: WebFetch",
    "okunuyor: /etc/hosts",
    "okunuyor: ~/elsewhere/x.txt",
]


@pytest.mark.parametrize("lang, expected", [("en", EN), ("tr", TR)])
def test_claude_steps_are_short_labels_without_results(home, monkeypatch, lang, expected):
    monkeypatch.setattr(i18n, "LANG", lang)
    cwd = str(home / "proj")
    steps = [s for entry in _transcript(cwd, home) for s in follow.claude_steps(entry, cwd)]
    assert steps == expected
    shown = "\n".join(steps)
    for secret in ("BODY", "PROMPT", "private reasoning", "hidden-value", "REPEATED", "SIDECHAIN", "abcdefghijklmnop"):
        assert secret not in shown


def _codex_events(cwd):
    run = "/bin/zsh -lc 'rg -n follow src'"
    change = [{"path": f"{cwd}/src/a.py", "kind": "update"}]
    return [
        {"type": "thread.started", "thread_id": "t-1"},
        {"type": "turn.started"},
        {"type": "item.started", "item": {"id": "item_0", "type": "command_execution", "command": run, "aggregated_output": "",
                                          "exit_code": None, "status": "in_progress"}},
        {"type": "item.completed", "item": {"id": "item_0", "type": "command_execution", "command": run,
                                            "aggregated_output": "COMMAND OUTPUT", "exit_code": 0, "status": "completed"}},
        {"type": "item.completed", "item": {"id": "item_1", "type": "reasoning", "text": "private reasoning"}},
        {"type": "item.started", "item": {"id": "item_2", "type": "file_change", "changes": change, "status": "in_progress"}},
        {"type": "item.completed", "item": {"id": "item_2", "type": "file_change", "changes": change, "status": "completed"}},
        {"type": "item.started", "item": {"id": "item_3", "type": "agent_message", "text": ""}},
        {"type": "item.completed", "item": {"id": "item_3", "type": "agent_message", "text": "Fixed it.\nDetails follow."}},
        {"type": "item.completed", "item": {"id": "item_4", "type": "error", "message": "hook failed"}},
        {"type": "turn.completed", "usage": {"input_tokens": 1}},
    ]


@pytest.mark.parametrize("lang, expected", [("en", ["command: rg -n follow src", "editing: src/a.py", "› Fixed it.…"]),
                                            ("tr", ["komut: rg -n follow src", "düzenleniyor: src/a.py", "› Fixed it.…"])])
def test_codex_steps_show_each_item_once(home, monkeypatch, lang, expected):
    monkeypatch.setattr(i18n, "LANG", lang)
    cwd, seen = str(home / "proj"), set()
    assert [s for ev in _codex_events(cwd) for s in follow.codex_steps(ev, cwd, seen)] == expected


def _job(home, **kw):
    fields = {"id": "20261026-120000-abcd", "account": "second", "dir": str(home / ".claude-second"),
              "cwd": str(home / "proj"), "started": 1000.0, **kw}
    job = jobs.Job(**fields)
    jobs.save(job)
    return job


def _write(path, entries, end="\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write("".join(json.dumps(e) + "\n" for e in entries[:-1]) + (json.dumps(entries[-1]) + end if entries else ""))


def test_follow_waits_for_the_file_then_prints_new_steps_until_the_job_ends(home, monkeypatch):
    monkeypatch.setattr(i18n, "LANG", "en")
    monkeypatch.setattr(follow.jobs, "refresh", lambda job: job)
    cwd = str(home / "proj")
    tp = claude.project_dir(home / ".claude-second", cwd) / "s-1.jsonl"
    job = _job(home, session_id="s-1", transcript_path=str(tp))
    partial = json.dumps(_assistant(_tool("Edit", file_path=f"{cwd}/b.py")))

    def appear():
        _write(tp, [_assistant(_text("Starting.")), _assistant(_tool("Read", file_path=f"{cwd}/a.py"))])

    def half_line():
        with open(tp, "a", encoding="utf-8") as f:
            f.write(partial[:20])

    def rest_and_end():
        with open(tp, "a", encoding="utf-8") as f:
            f.write(partial[20:] + "\n")
        _write(tp, [_assistant(_tool("Bash", command="pytest -q"))])
        jobs.save(jobs.Job(**{**vars(job), "status": "done", "finished": 1125.0, "cost_usd": 1.234, "num_turns": 7}))

    actions = [appear, half_line, rest_and_end]
    monkeypatch.setattr(follow.time, "sleep", lambda s: actions.pop(0)())
    out = io.StringIO()
    assert follow.run(job.id, out=out) == 0
    assert out.getvalue().splitlines() == ["› Starting.", "reading: a.py", "editing: b.py", "command: pytest -q",
                                           "done · 2m 5s · $1.23 · 7 turns"]
    assert actions == []


def test_a_step_written_as_the_job_ends_is_still_printed(home, monkeypatch):
    monkeypatch.setattr(i18n, "LANG", "en")
    cwd = str(home / "proj")
    tp = claude.project_dir(home / ".claude-second", cwd) / "s-6.jsonl"
    _write(tp, [_assistant(_text("Working."))])
    job = _job(home, session_id="s-6", transcript_path=str(tp))

    def refresh(j):
        # The last line lands and the job ends between two reads.
        if refresh.calls:
            _write(tp, [_assistant(_text("All done."))])
            j = jobs.Job(**{**vars(j), "status": "done", "finished": 1001.0})
        refresh.calls += 1
        return j

    refresh.calls = 0
    monkeypatch.setattr(follow.jobs, "refresh", refresh)
    monkeypatch.setattr(follow.time, "sleep", lambda s: None)
    out = io.StringIO()
    assert follow.run(job.id, out=out) == 0
    assert out.getvalue().splitlines() == ["› Working.", "› All done.", "done · 1s"]


@pytest.mark.parametrize("status, error, summary, rc", [
    ("done", "", "bitti · 1sa 1dk · 3 tur", 0),
    ("failed", "boom\ntrace", "başarısız · 1sa 1dk · 3 tur: boom…", 1),
    ("cancelled", "", "iptal edildi · 1sa 1dk · 3 tur", 1),
])
def test_a_finished_job_prints_its_steps_and_summary_at_once(home, monkeypatch, status, error, summary, rc):
    monkeypatch.setattr(i18n, "LANG", "tr")
    monkeypatch.setattr(follow.time, "sleep", lambda s: pytest.fail("waited on a finished job"))
    cwd = str(home / "proj")
    tp = claude.project_dir(home / ".claude-second", cwd) / "s-2.jsonl"
    _write(tp, [_assistant(_tool("Read", file_path=f"{cwd}/a.py"))])
    job = _job(home, session_id="s-2", transcript_path=str(tp), status=status, error=error, finished=1000.0 + 3660,
               num_turns=3)
    out = io.StringIO()
    assert follow.run(job.id, out=out) == rc
    assert out.getvalue().splitlines() == ["okunuyor: a.py", summary]


def _at(epoch):
    import datetime
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def test_only_the_jobs_own_run_is_shown_from_a_shared_session_file(home, monkeypatch):
    monkeypatch.setattr(i18n, "LANG", "en")
    cwd = str(home / "proj")
    tp = claude.project_dir(home / ".claude-second", cwd) / "s-7.jsonl"
    # A resumed session keeps one file: the run before this job, this job, and a later run that resumed it again.
    _write(tp, [_assistant(_text("earlier run"), timestamp=_at(900)), _assistant(_text("this run"), timestamp=_at(1000.5)),
                _assistant(_text("no time")), _assistant(_text("later run"), timestamp=_at(1200))])
    job = _job(home, session_id="s-7", transcript_path=str(tp), status="done", finished=1100.0)
    out = io.StringIO()
    assert follow.run(job.id, out=out) == 0
    assert out.getvalue().splitlines() == ["› this run", "› no time", "done · 1m 40s"]


def test_a_closed_pipe_ends_the_follow_quietly(home):
    class Gone(io.StringIO):
        def write(self, s):
            raise BrokenPipeError

    tp = claude.project_dir(home / ".claude-second", home / "proj") / "s-8.jsonl"
    _write(tp, [_assistant(_text("hello"))])
    job = _job(home, session_id="s-8", transcript_path=str(tp), status="done", finished=1001.0)
    assert follow.run(job.id, out=Gone()) == 0


def test_ctrl_c_ends_the_follow_quietly(home, monkeypatch):
    monkeypatch.setattr(follow.jobs, "refresh", lambda job: job)

    def interrupt(seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(follow.time, "sleep", interrupt)
    job = _job(home, session_id="s-3")
    assert follow.run(job.id, out=io.StringIO()) == 130


def test_a_codex_job_is_followed_through_its_event_stream(home, monkeypatch):
    monkeypatch.setattr(i18n, "LANG", "en")
    job = _job(home, account="codex", dir="", backend="codex", status="done", finished=1002.0)
    # A record from before log_path was kept reads the stream from its usual place.
    _write(jobs._p(job.id, "out"), _codex_events(job.cwd))
    out = io.StringIO()
    assert follow.run(job.id, out=out) == 0
    assert out.getvalue().splitlines() == ["command: rg -n follow src", "editing: src/a.py", "› Fixed it.…", "done · 2s"]


def test_a_transcript_written_elsewhere_is_found_by_its_session(home):
    job = _job(home, session_id="s-4", transcript_path=str(home / "nowhere" / "s-4.jsonl"))
    assert follow.source(job) is None
    found = home / ".claude-second" / "projects" / "-other" / "s-4.jsonl"
    _write(found, [_assistant(_text("hi"))])
    assert follow.source(job) == found


def test_a_job_without_a_session_id_reads_the_newest_transcript_since_it_started(home):
    folder = claude.project_dir(home / ".claude-second", home / "proj")
    job = _job(home, parent_session_id="parent")
    assert follow.source(job) is None
    for name, mtime in (("before.jsonl", 900), ("job.jsonl", 1100), ("parent.jsonl", 1200), ("agent-x.jsonl", 1300)):
        _write(folder / name, [_assistant(_text(name))])
        os.utime(folder / name, (mtime, mtime))
    # The calling chat's own transcript and subagent files never count.
    assert follow.source(job) == folder / "job.jsonl"


def test_cli_follow(home, monkeypatch, capsys):
    monkeypatch.setattr(i18n, "LANG", "en")
    cfg = config.load()
    cfg.lang = "tr"
    config.save(cfg)
    cwd = str(home / "proj")
    tp = claude.project_dir(home / ".claude-second", cwd) / "s-5.jsonl"
    _write(tp, [_assistant(_tool("Grep", pattern="TODO"))])
    job = _job(home, session_id="s-5", transcript_path=str(tp), status="done", finished=1004.0)
    assert cli.main(["jobs", "follow", job.id]) == 0
    assert capsys.readouterr().out.splitlines() == ["aranıyor: TODO", "bitti · 4sn"]
    assert cli.main(["jobs", "follow", "no-such-job"]) == 1
    assert "unknown job no-such-job" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        cli.main(["jobs", "follow"])
    capsys.readouterr()
    assert paths.jobs_dir().is_relative_to(home)
