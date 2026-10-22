"""Usage windows per account: the OAuth usage endpoint (unofficial, read-only) plus a short-lived cache."""
import concurrent.futures
import datetime
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import claude, paths

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
KINDS = ["session", "weekly_all", "weekly_scoped"]
FAMILIES = ("fable", "opus", "sonnet", "haiku")
TTL = 300


def fetch(token: str, timeout: float = 8.0):
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "shiftover",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 - any network failure degrades the same way
        return None, type(e).__name__


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


def cache_path():
    return paths.cache_dir() / "usage.json"


def load_cache() -> dict:
    c = paths.read_json(cache_path(), {})
    return c if isinstance(c, dict) else {}


def fresh(entry: dict | None, ttl: int = TTL) -> bool:
    return bool(entry) and (time.time() - float(entry.get("ts") or 0)) < ttl


def _probe(d: str) -> dict:
    em = claude.email(d)
    if not em:
        return {"ts": time.time(), "email": "", "err": "not logged in"}
    tok = claude.access_token(d)
    if not tok:
        return {"ts": time.time(), "email": em, "err": "no token (allow keychain access)"}
    data, err = fetch(tok)
    if err:
        if err == "HTTP 401":
            err += " (token expired: open claude once with this account)"
        return {"ts": time.time(), "email": em, "err": err}
    return {"ts": time.time(), "email": em, "limits": parse_limits(data), "extra": parse_extra(data)}


def refresh(dirs: list, ttl: int = TTL, force: bool = False, budget: float = 12.0) -> dict:
    """Returns {dir: entry}; entries younger than ttl come from the cache unless force."""
    cache = load_cache()
    keys = [str(claude.norm(d)) for d in dirs]
    todo = [k for k in keys if force or not fresh(cache.get(k), ttl)]
    if todo:
        # No context manager: leaving one would wait for every probe, blowing the caller's budget.
        ex = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(todo)))
        futs = {k: ex.submit(_probe, k) for k in todo}
        deadline = time.time() + budget
        for k, fut in futs.items():
            try:
                cache[k] = fut.result(timeout=max(0.1, deadline - time.time()))
            except concurrent.futures.TimeoutError:
                cache[k] = {"ts": time.time(), "email": claude.email(k), "err": "timeout"}
        ex.shutdown(wait=False, cancel_futures=True)
        paths.write_json(cache_path(), cache)
    return {k: cache.get(k) or {"email": claude.email(k), "err": "unknown"} for k in keys}


def refresh_detached() -> None:
    try:
        subprocess.Popen(
            [sys.executable, "-m", "shiftover", "usage", "--refresh", "--quiet"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass
