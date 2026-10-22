import json
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from . import claude, paths


class ConfigError(Exception):
    pass


@dataclass
class Account:
    name: str
    dir: str
    email: str = ""
    models: list[str] | None = None
    enabled: bool = True

    @property
    def path(self) -> Path:
        return claude.norm(self.dir)

    def allows_model(self, family: str | None) -> bool:
        if not family or not self.models:
            return True
        return any(family in m.lower() for m in self.models)


@dataclass
class Config:
    main: str = ""
    threshold: int = 95
    lang: str = "en"
    accounts: dict = field(default_factory=dict)
    handoff_mode: str = "auto"
    delegate_wait: int = 90
    delegate_permission_mode: str = "default"
    delegate_mcp: str = "none"
    delegate_allow_bypass: bool = False
    tips_enabled: bool = True
    tips_min_interval: int = 10
    tips_levels: list = field(default_factory=lambda: [75, 90])
    map: dict = field(default_factory=dict)
    statusline_wrap: str = ""
    path: Path | None = None

    def ordered(self) -> list[Account]:
        accts = [a for a in self.accounts.values() if a.enabled]
        main = [a for a in accts if a.name == self.main]
        return main + [a for a in accts if a.name != self.main]

    def main_account(self) -> Account | None:
        a = self.accounts.get(self.main)
        if a:
            return a
        o = self.ordered()
        return o[0] if o else None

    def by_dir(self, d) -> Account | None:
        p = claude.norm(d)
        for a in self.accounts.values():
            if a.path == p:
                return a
        return None

    def resolve(self, spec: str | None) -> Account | None:
        if spec is None or spec == "":
            return None
        s = str(spec).strip()
        if s.lower() in ("main", "default") and self.main:
            return self.accounts.get(self.main)
        for a in self.accounts.values():
            if a.name.lower() == s.lower():
                return a
        if s.isdigit():
            o = self.ordered()
            i = int(s)
            return o[i - 1] if 1 <= i <= len(o) else None
        for a in self.accounts.values():
            if s.lower() in a.name.lower() or s.lower() in a.path.name.lower() or s.lower() in a.email.lower():
                return a
        return None

    def for_cwd(self, cwd) -> Account | None:
        cwd = str(Path(cwd).absolute())
        best, best_len = None, -1
        for prefix, name in self.map.items():
            p = str(claude.norm(prefix))
            if (cwd == p or cwd.startswith(p.rstrip("/") + "/")) and len(p) > best_len:
                best, best_len = self.accounts.get(name), len(p)
        return best


def _acct_from(name: str, d: dict) -> Account:
    return Account(
        name=name, dir=str(d.get("dir", "")), email=str(d.get("email", "")),
        models=list(d["models"]) if d.get("models") else None, enabled=bool(d.get("enabled", True)),
    )


def from_dict(data: dict, path: Path | None = None) -> Config:
    cfg = Config(path=path)
    cfg.main = str(data.get("main", ""))
    cfg.threshold = int(data.get("threshold", 95))
    cfg.lang = str(data.get("lang", "en"))
    for name, d in (data.get("accounts") or {}).items():
        cfg.accounts[name] = _acct_from(name, d or {})
    h = data.get("handoff") or {}
    cfg.handoff_mode = str(h.get("mode", "auto"))
    dl = data.get("delegate") or {}
    cfg.delegate_wait = int(dl.get("wait_seconds", 90))
    cfg.delegate_permission_mode = str(dl.get("permission_mode", "default"))
    cfg.delegate_mcp = str(dl.get("mcp", "none"))
    cfg.delegate_allow_bypass = bool(dl.get("allow_bypass", False))
    tp = data.get("tips") or {}
    cfg.tips_enabled = bool(tp.get("enabled", True))
    cfg.tips_min_interval = int(tp.get("min_interval_min", 10))
    cfg.tips_levels = [int(x) for x in tp.get("levels", [75, 90])]
    cfg.map = {str(k): str(v) for k, v in (data.get("map") or {}).items()}
    cfg.statusline_wrap = str((data.get("statusline") or {}).get("wrap", ""))
    if not cfg.main and cfg.accounts:
        cfg.main = next(iter(cfg.accounts))
    return cfg


def load(path: Path | None = None) -> Config:
    path = path or paths.config_file()
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError("no config") from None
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"cannot read {path}: {e}") from None
    return from_dict(data, path)


def load_or_none(path: Path | None = None) -> Config | None:
    try:
        return load(path)
    except ConfigError:
        return None


def _v(x) -> str:
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, (int, float)):
        return str(x)
    if isinstance(x, (list, tuple)):
        return "[" + ", ".join(_v(i) for i in x) + "]"
    return json.dumps(str(x), ensure_ascii=False)


def to_toml(cfg: Config) -> str:
    lines = [f"main = {_v(cfg.main)}", f"threshold = {_v(cfg.threshold)}", f"lang = {_v(cfg.lang)}", ""]
    for a in cfg.accounts.values():
        lines += [f"[accounts.{a.name}]" if a.name.replace("-", "").replace("_", "").isalnum() else f'[accounts.{json.dumps(a.name)}]',
                  f"dir = {_v(a.dir)}", f"email = {_v(a.email)}"]
        if a.models:
            lines.append(f"models = {_v(a.models)}")
        if not a.enabled:
            lines.append("enabled = false")
        lines.append("")
    lines += ["[handoff]", f"mode = {_v(cfg.handoff_mode)}", "",
              "[delegate]", f"wait_seconds = {_v(cfg.delegate_wait)}", f"permission_mode = {_v(cfg.delegate_permission_mode)}",
              f"mcp = {_v(cfg.delegate_mcp)}", f"allow_bypass = {_v(cfg.delegate_allow_bypass)}", "",
              "[tips]", f"enabled = {_v(cfg.tips_enabled)}", f"min_interval_min = {_v(cfg.tips_min_interval)}",
              f"levels = {_v(cfg.tips_levels)}", "",
              "[statusline]", f"wrap = {_v(cfg.statusline_wrap)}", "",
              "[map]"]
    for k, v in cfg.map.items():
        lines.append(f"{json.dumps(k, ensure_ascii=False)} = {_v(v)}")
    return "\n".join(lines) + "\n"


def save(cfg: Config, path: Path | None = None) -> Path:
    path = path or cfg.path or paths.config_file()
    paths.write_private(path, to_toml(cfg))
    cfg.path = path
    return path


def discover_dirs() -> list[Path]:
    out = []
    if claude.DEFAULT_DIR.is_dir():
        out.append(claude.DEFAULT_DIR)
    for p in sorted(Path.home().glob(".claude-*")):
        if not p.is_dir() or (p.is_symlink() and p.resolve() == claude.DEFAULT_DIR.resolve()):
            continue
        # Plugins and tools keep scratch config dirs too; only a dir someone signed into is an account.
        if (p / ".claude.json").exists():
            out.append(p)
    return out


def default_name(d: Path) -> str:
    if claude.is_default(d):
        return "main"
    n = d.name[len(".claude-"):] if d.name.startswith(".claude-") else d.name.lstrip(".")
    return n or "account"


def import_existing(names: dict[str, str] | None = None, main: str | None = None) -> Config:
    names = {str(claude.norm(k)): v for k, v in (names or {}).items()}
    cfg = Config()
    for d in discover_dirs():
        name = names.get(str(claude.norm(d))) or default_name(d)
        home = str(Path.home())
        shown = "~" + str(d)[len(home):] if str(d).startswith(home) else str(d)
        cfg.accounts[name] = Account(name=name, dir=shown, email=claude.email(d))
    if main and main in cfg.accounts:
        cfg.main = main
    elif cfg.accounts:
        cfg.main = next((a.name for a in cfg.accounts.values() if claude.is_default(a.path)), next(iter(cfg.accounts)))
    return cfg
