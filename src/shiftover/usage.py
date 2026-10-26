"""Usage windows per account: the OAuth usage endpoint (unofficial, read-only) plus a short-lived cache."""
import concurrent.futures
import contextlib
import datetime
import fcntl
import hashlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import claude, paths
from .i18n import t

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
KINDS = ["session", "weekly_all", "weekly_scoped"]
FAMILIES = ("fable", "opus", "sonnet", "haiku")
TTL = 300
ERROR_TTL = 60
LOCK_WAIT = 3.0
JITTER = 5.0
RENEW_MARGIN = 300
RENEW_BACKOFF = 900
# Cached as they are; error() words them in the UI language.
RENEWING = "renewing token"
LOGIN_REQUIRED = "login required"
WORDS = {RENEWING: "renewing", LOGIN_REQUIRED: "login_required"}


def fetch(token: str, timeout: float = 8.0):
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "shiftover",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r), None, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}", e.headers.get("Retry-After") if e.headers else None
    except Exception as e:  # noqa: BLE001 - any network failure degrades the same way
        return None, type(e).__name__, None


def retry_after(value) -> int:
    try:
        seconds = int(value)
        if seconds >= 0:
            return min(seconds, 7200)
    except (TypeError, ValueError, OverflowError):
        pass
    return 600


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:12] if token else ""


def error(entry: dict) -> str:
    err = entry.get("err") or ""
    if err == "HTTP 429" and entry.get("retry_at") is not None:
        minutes = max(0, int((entry["retry_at"] - time.time() + 59) // 60))
        err += f" ({t('retry_in', n=minutes)})"
    elif err in WORDS:
        err = t(WORDS[err])
    return err


def expired(tok) -> bool:
    """A token whose known expiry is past or at most RENEW_MARGIN seconds away."""
    exp = getattr(tok, "expires_at", None)
    return exp is not None and exp - time.time() <= RENEW_MARGIN


def parse_limits(data: dict) -> list[dict]:
    out = []
    lims = data.get("limits")
    if isinstance(lims, list) and lims:
        for lim in lims:
            kind, pct = lim.get("kind"), lim.get("percent")
            if kind not in KINDS or not isinstance(pct, (int, float)):
                continue
            model = ((lim.get("scope") or {}).get("model") or {}).get("display_name") or ""
            out.append({"kind": kind, "model": model, "used": float(pct), "resets_at": lim.get("resets_at")})
    else:
        for kind, key in (("session", "five_hour"), ("weekly_all", "seven_day")):
            v = data.get(key)
            if v and isinstance(v.get("utilization"), (int, float)):
                out.append({"kind": kind, "model": "", "used": float(v["utilization"]), "resets_at": v.get("resets_at")})
    out.sort(key=lambda x: KINDS.index(x["kind"]))
    return out


def parse_extra(data: dict) -> str:
    extra = data.get("extra_usage") or {}
    if extra.get("is_enabled") and isinstance(extra.get("utilization"), (int, float)):
        return f"extra {extra.get('used_credits', 0):.0f}/{extra.get('monthly_limit', 0):.0f} {extra.get('currency', '')}".strip()
    return ""


def model_family(spec: str | None) -> str | None:
    if not spec:
        return None
    s = spec.lower()
    for fam in FAMILIES:
        if fam in s:
            return fam
    return None


def applies(limit: dict, family: str | None) -> bool:
    if limit["kind"] != "weekly_scoped":
        return True
    return bool(family) and family in (limit.get("model") or "").lower()


def blocking(limits: list[dict], family: str | None = None) -> list[dict]:
    return [lim for lim in limits if lim["used"] >= 100 and applies(lim, family)]


def headroom(limits: list[dict], family: str | None = None) -> float:
    vals = [100.0 - lim["used"] for lim in limits if applies(lim, family)]
    return max(0.0, min(vals)) if vals else 100.0


def parse_ts(iso):
    if not iso:
        return None
    if isinstance(iso, (int, float)):
        return datetime.datetime.fromtimestamp(iso, datetime.timezone.utc).astimezone()
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def until(t, now=None) -> str:
    now = now or datetime.datetime.now(datetime.timezone.utc).astimezone()
    s = int((t - now).total_seconds())
    if s <= 0:
        return ""
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m = s // 60
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


def reset_in(limit: dict, now=None) -> str:
    t = parse_ts(limit.get("resets_at"))
    return until(t, now) if t else ""


def reset_passed(limit: dict, now=None) -> bool:
    t = parse_ts(limit.get("resets_at"))
    return t is not None and t <= (now or datetime.datetime.now(datetime.timezone.utc))


def cache_path():
    return paths.cache_dir() / "usage.json"


def load_cache() -> dict:
    c = paths.read_json(cache_path(), {})
    return c if isinstance(c, dict) else {}


def _short_lived(entry: dict) -> bool:
    # Errors retry after ERROR_TTL, except a bad or unreadable token: that waits for a re-login,
    # which the fingerprint check notices at once.
    err = entry.get("err") or ""
    return bool(err) and not err.startswith(("HTTP 401", "no token", LOGIN_REQUIRED))


def fresh(entry: dict | None, ttl: int = TTL, token_fp: str | None = None) -> bool:
    # Only a token that was read and differs invalidates: an unreadable keychain says nothing.
    if not entry or (token_fp and entry.get("token_fp", "") != token_fp):
        return False
    if entry.get("retry_at") is not None:
        return time.time() < entry["retry_at"]
    if ttl <= 0:
        return False
    if _short_lived(entry):
        ttl = min(ttl, ERROR_TTL)
    return (time.time() - float(entry.get("ts") or 0)) < ttl


def _settled(entry: dict | None, ttl: int) -> bool:
    """A good entry inside its TTL: served as is, without reading the keychain."""
    return bool(entry) and not entry.get("err") and fresh(entry, ttl)


def next_refresh(entry: dict | None) -> float | None:
    if not entry or entry.get("ts") is None:
        return None
    if entry.get("retry_at") is not None:
        return float(entry["retry_at"])
    return float(entry["ts"]) + (ERROR_TTL if _short_lived(entry) else TTL)


def known_limits(prev: dict | None, email: str) -> dict:
    """The windows last read for this sign-in, with their read time, to carry through a failed read."""
    if not prev or "limits" not in prev or not email or prev.get("email") != email:
        return {}
    out = {k: prev[k] for k in ("limits", "extra") if k in prev}
    out["limits_ts"] = prev.get("limits_ts", prev.get("ts"))
    return out


def _backoff(prev: dict | None) -> dict:
    """The last renewal attempt, carried into the next entry while it still holds another one back."""
    at = (prev or {}).get("renew_at")
    return {"renew_at": at} if isinstance(at, (int, float)) and time.time() - at < RENEW_BACKOFF else {}


def _read(entry: dict, prev: dict | None, data, err, retry) -> dict:
    """The entry for a usage call answered at entry["ts"]."""
    if err:
        if err == "HTTP 429":
            entry["retry_at"] = entry["ts"] + retry_after(retry)
        # A 429 or a timeout says nothing new about the windows: the last ones read still decide.
        return {**entry, "err": err, **(known_limits(prev, entry["email"]) if err in ("HTTP 429", "TimeoutError") else {})}
    return {**entry, "limits": parse_limits(data), "extra": parse_extra(data)}


def _probe(d: str, tok: str, prev: dict | None = None, renew: bool = False) -> dict:
    em = claude.email(d)
    entry = {"ts": time.time(), "email": em, "token_fp": fingerprint(tok), **_backoff(prev)}
    if not em:
        return {**entry, "err": "not logged in"}
    if not tok:
        return {**entry, "err": "no token (allow keychain access)"}
    if not expired(tok):
        data, err, retry = fetch(tok)
        entry["ts"] = time.time()
        if err != "HTTP 401":
            return _read(entry, prev, data, err, retry)
    # Expired or refused: Claude Code renews a token only while it runs, so shiftover runs it once per RENEW_BACKOFF.
    if "renew_at" in entry:
        return {**entry, "err": LOGIN_REQUIRED}
    if not renew:
        # That run takes a while: a caller that waits gets the last windows and the detached refresh does it.
        return {**entry, "err": RENEWING, **known_limits(prev, em)}
    return _renew(d, tok, prev, entry)


def _renew(d: str, tok: str, prev: dict | None, entry: dict) -> dict:
    """Has claude renew the token, then reads usage with the new one at once. Background refresh only."""
    entry = {**entry, "renew_at": time.time()}
    claude.renew(d)
    # The token decides, not the exit status: a turn on a full account fails after the token was renewed.
    new = claude.access_token(d)
    exp = getattr(new, "expires_at", None)
    entry["ts"] = time.time()
    if not new or exp is None or exp <= max(getattr(tok, "expires_at", None) or 0, entry["ts"]):
        # Not renewed: the refresh token is no longer good, only a login helps.
        return {**entry, "err": LOGIN_REQUIRED}
    entry["token_fp"] = fingerprint(new)
    data, err, retry = fetch(new)
    entry["ts"] = time.time()
    if err == "HTTP 401":
        return {**entry, "err": LOGIN_REQUIRED}
    return _read(entry, prev, data, err, retry)


def _cached_probe(d: str, ttl: int, fps: dict, renew: bool = False) -> dict:
    tok = claude.access_token(d)
    fps[d] = fingerprint(tok)
    # Read after the lookup: the keychain can be slow and the entry may have changed meanwhile.
    entry = load_cache().get(d)
    # A pending renewal is the background refresh's job, however fresh its entry.
    if fresh(entry, ttl, fps[d]) and not (renew and entry.get("err") == RENEWING):
        return entry
    return _probe(d, tok, entry, renew)


@contextlib.contextmanager
def _lock(wait: float = 0.0):
    """The cross-process usage lock, waited for up to `wait` seconds; yields whether it is held."""
    paths.ensure_dir(paths.cache_dir())
    with (paths.cache_dir() / "usage.lock").open("a") as f:
        end = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = True
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    held = False
                    break
                time.sleep(0.05)
        yield held


def _keys(dirs: list) -> list[str]:
    return list(dict.fromkeys(str(claude.norm(d)) for d in dirs))


def _report(cache: dict, keys: list) -> dict:
    return {k: cache.get(k) or {"email": claude.email(k), "err": "unknown"} for k in keys}


def refresh(dirs: list, ttl: int = TTL, force: bool = False, budget: float | None = 12.0) -> dict:
    """Returns {dir: entry}; force bypasses the TTL but respects Retry-After. One process probes at a time."""
    keys = _keys(dirs)
    cache = load_cache()
    if not keys or (not force and all(_settled(cache.get(k), ttl) for k in keys)):
        return _report(cache, keys)
    start = time.monotonic()
    with _lock(LOCK_WAIT if budget is None else min(LOCK_WAIT, budget)) as held:
        out = _refresh(keys, ttl, force, None if budget is None else budget - (time.monotonic() - start)) if held else None
    if out is None:
        # Another process is probing these accounts: report the cache rather than probing them twice.
        out = _report(load_cache(), keys)
    if any(e.get("err") == RENEWING for e in out.values()):
        # A renewal runs claude for a minute or more: the detached refresh does it, once this lock is free.
        refresh_detached()
    return out


def _refresh(dirs: list, ttl: int, force: bool, budget: float | None, renew: bool = False) -> dict:
    """refresh() with the usage lock held: probe only what is still stale, then merge into the latest cache."""
    keys = _keys(dirs)
    cache = load_cache()
    todo = [k for k in keys if force or not _settled(cache.get(k), ttl)]
    updates = {}
    if todo:
        # No context manager: leaving one would wait for every probe, blowing the caller's budget.
        ex = concurrent.futures.ThreadPoolExecutor(max_workers=len(todo))
        fps = {}
        futs = {k: ex.submit(_cached_probe, k, 0 if force else ttl, fps, renew) for k in todo}
        deadline = time.monotonic() + budget if budget is not None else None
        for k, fut in futs.items():
            try:
                entry = fut.result(timeout=max(0.1, deadline - time.monotonic()) if deadline is not None else None)
            except concurrent.futures.TimeoutError:
                entry = cache.get(k) or {}
                # A slow keychain or network never replaces an entry that is still good to use.
                if fresh(entry, TTL, fps.get(k)):
                    continue
                em = claude.email(k)
                entry = {"ts": time.time(), "email": em, "token_fp": fps.get(k, entry.get("token_fp", "")),
                         "err": "timeout", **known_limits(entry, em), **_backoff(entry)}
            if entry != cache.get(k):
                updates[k] = entry
        ex.shutdown(wait=False, cancel_futures=True)
    if updates:
        cache = load_cache()
        cache.update(updates)
        paths.write_json(cache_path(), cache)
    return _report(cache, keys)


def refresh_stale(dirs: list) -> dict:
    """The detached background refresh, the only one that renews tokens: gives up at once while another process holds the lock."""
    with _lock() as held:
        return _refresh(dirs, TTL, False, None, renew=True) if held else {}


def store(key: str, entry: dict) -> None:
    """Writes one entry into the latest cache under the usage lock."""
    # Written even if the wait runs out: a stuck holder must not cost this record.
    with _lock(LOCK_WAIT):
        cache = load_cache()
        cache[key] = entry
        paths.write_json(cache_path(), cache)


def refresh_detached() -> None:
    try:
        subprocess.Popen(
            [sys.executable, "-m", "shiftover", "usage", "--stale", "--quiet"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass
