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
    assert set(cfg.accounts) == {"main", "work", "third"}
    assert cfg.main == "main"
    assert cfg.accounts["work"].email == "two@example.com"
    assert cfg.accounts["work"].dir == "~/.claude-second"
