import tomllib

from shiftover import config


def test_roundtrip(home):
    cfg = config.load()
    cfg.map = {"~/a b": "second"}
    cfg.statusline_wrap = 'bash "$HOME/x.sh"'
    cfg.accounts["second"].models = ["opus", "sonnet"]
    cfg.accounts["third"].enabled = False
    text = config.to_toml(cfg)
    data = tomllib.loads(text)
    assert data["accounts"]["second"]["models"] == ["opus", "sonnet"]
    assert data["accounts"]["third"]["enabled"] is False
    assert data["map"]["~/a b"] == "second"
    assert data["statusline"]["wrap"] == 'bash "$HOME/x.sh"'
    back = config.from_dict(data)
    assert [a.name for a in back.ordered()] == ["main", "second"]


def test_import_existing_discovers_dirs(home):
    cfg = config.import_existing({"~/.claude-second": "work"}, main=None)
    assert set(cfg.accounts) == {"one", "work", "three"}
    assert cfg.main == "one"
    assert cfg.accounts["work"].email == "two@example.com"
    assert cfg.accounts["work"].dir == "~/.claude-second"


def test_names_come_from_emails_and_stay_unique(home):
    from pathlib import Path
    assert config.default_name(Path("~/.claude"), "Kadir.Aktas@example.com") == "kadir-aktas"
    assert config.default_name(Path("~/.claude-x"), "", ()) == "x"
    assert config.default_name(Path("~/.claude"), "one@example.com", ("one",)) == "one2"


def test_merge_discovered_adds_only_new_dirs(home):
    cfg = config.load()
    assert config.merge_discovered(cfg) == []
    import json
    d = home / ".claude-fourth"
    d.mkdir()
    (d / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "four@example.com"}}))
    added = config.merge_discovered(cfg)
    assert [a.name for a in added] == ["four"] and cfg.accounts["four"].dir == "~/.claude-fourth"


def test_import_skips_dirs_without_login(home):
    (home / ".claude-scratch").mkdir()
    (home / ".claude-scratch" / "settings.json").write_text("{}")
    cfg = config.import_existing({}, main=None)
    assert "scratch" not in cfg.accounts


def test_adopt_emails_fills_blanks_from_live_login(home):
    cfg = config.load()
    acct = cfg.by_dir(home / ".claude-second")
    acct.email = ""
    assert config.adopt_emails(cfg) == [acct]
    assert acct.email == "two@example.com"
    assert config.adopt_emails(cfg) == []
