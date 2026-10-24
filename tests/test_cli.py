import argparse
import json
import os
import subprocess
from pathlib import Path

from shiftover import cli, config, paths, runner, ui, usage


def _seed_limits(spec):
    cfg = config.load()
    paths.write_json(usage.cache_path(), {str(cfg.accounts[n].path): {"ts": 10**12, "email": cfg.accounts[n].email, "limits": [
        {"kind": k, "model": m, "used": u, "resets_at": None} for k, m, u in lims]} for n, lims in spec.items()})


def _capture_run(monkeypatch):
    seen = []
    monkeypatch.setattr(cli.claude, "claude_bin", lambda: "claude")
    monkeypatch.setattr(runner, "run", lambda cfg, acct, args, interactive=None: seen.append((acct.name, list(args))) or 0)
    return seen


def test_cl_opens_the_main_flow_and_leaves_the_menu_opt_in(capsys):
    cli.cmd_shell_init(argparse.Namespace(no_cl=False))
    init = capsys.readouterr().out
    assert "--menu" not in init
    script = ('shiftover() { printf "%s|" "$@"; echo; }\n' + init +
              '\ncl "$1" --dangerously-skip-permissions\ncl "$1" --menu -x\ncl --menu\ncl -p hi\n')
    out = subprocess.run(["bash", "-c", script, "bash", "/"], capture_output=True, text=True, check=True).stdout
    assert out.splitlines() == ["run|-C|/|--dangerously-skip-permissions|", "run|-C|/|--menu|-x|", "run|--menu|", "run|-p|hi|"]


def test_run_takes_menu_on_either_side_of_chdir(home, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    seen = _capture_run(monkeypatch)
    shown = []
    monkeypatch.setattr(ui, "menu", lambda rows, sel, msg, hint: shown.append(rows[sel]["name"]) or sel)
    _seed_limits({"main": [("session", "", 10)], "second": [("session", "", 10)], "third": [("session", "", 10)]})
    proj = tmp_path / "proj"
    proj.mkdir()
    for argv in (["-C", str(proj), "--menu", "--dangerously-skip-permissions"],
                 ["--menu", "-C", str(proj), "--dangerously-skip-permissions"]):
        os.chdir(tmp_path)
        assert cli.cmd_run(argv) == 0
        assert Path(os.getcwd()).resolve() == proj.resolve()
    assert shown == ["main", "main"] and seen == [("main", ["--dangerously-skip-permissions"])] * 2


def test_run_counts_the_model_window_of_the_settings_default(home, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    seen = _capture_run(monkeypatch)
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "fable"}))
    _seed_limits({"main": [("session", "", 10), ("weekly_scoped", "Fable", 100)],
                  "second": [("session", "", 50)], "third": [("session", "", 60)]})
    assert cli.cmd_run(["--dangerously-skip-permissions"]) == 0
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
    assert cli.cmd_run([]) == 0
    assert cli.cmd_run(["--model", "fable"]) == 0
    assert [name for name, _ in seen] == ["second", "main", "second"]
