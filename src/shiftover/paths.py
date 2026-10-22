import datetime
import json
import os
import tempfile
from pathlib import Path

HOME = Path.home()


def config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    return (Path(base) if base else HOME / ".config") / "shiftover"


def config_file() -> Path:
    return config_dir() / "config.toml"


def cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME")
    return (Path(base) if base else HOME / ".cache") / "shiftover"


def sessions_dir() -> Path:
    return cache_dir() / "sessions"


def runs_dir() -> Path:
    return cache_dir() / "runs"


def jobs_dir() -> Path:
    return cache_dir() / "jobs"


def tmp_dir() -> Path:
    return cache_dir() / "tmp"


def log_file() -> Path:
    return cache_dir() / "shiftover.log"


def ensure_dir(p: Path, mode: int = 0o700) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    try:
        p.chmod(mode)
    except OSError:
        pass
    return p


def write_private(p: Path, text: str) -> None:
    ensure_dir(p.parent)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(p: Path, obj) -> None:
    write_private(p, json.dumps(obj, ensure_ascii=False))


def read_json(p: Path, default=None):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def log(msg: str) -> None:
    try:
        ensure_dir(cache_dir())
        with open(log_file(), "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except OSError:
        pass
