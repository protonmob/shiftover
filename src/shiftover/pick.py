"""Which account to open or hand work to."""
import datetime

from . import usage
from .config import Config
from .i18n import t

LABELS = {"session": "l_session", "weekly_all": "l_week", "weekly_scoped": "l_week_model"}


def label(lim: dict) -> str:
    return t(LABELS[lim["kind"]], model=lim.get("model") or "model")


def rows_for(cfg: Config, entries: dict) -> list[dict]:
    rows = []
    for a in cfg.ordered():
        e = entries.get(str(a.path)) or {}
        row = {"account": a, "name": a.name, "email": e.get("email") or a.email, "dir": str(a.path)}
        if not e.get("email"):
            row["err"] = "not logged in"
            row["email"] = ""
        elif e.get("err"):
            row["err"] = e["err"]
        if "limits" in e:
            row["limits"] = e["limits"]
        if e.get("extra"):
            row["extra"] = e["extra"]
        rows.append(row)
    return rows


def summary(row: dict) -> str:
    return " · ".join(t("used_summary", label=label(lim), used=f"{lim['used']:.0f}") for lim in row.get("limits") or []) or t("no_limit_info")


def why_blocked(row: dict, family: str | None = None, now=None) -> str:
    parts = []
    for lim in usage.blocking(row.get("limits") or [], family):
        rs = usage.reset_in(lim, now)
        parts.append(t("full", label=label(lim)) + (f" ({t('resets_in', t=rs)})" if rs else ""))
    return "; ".join(parts)


def eligible(row: dict, family: str | None = None) -> bool:
    return bool(row.get("email")) and row["account"].allows_model(family)


def choose(cfg: Config, rows: list[dict], prefer=None, family: str | None = None, exclude=()) -> tuple[dict | None, str]:
    """First account in order that is logged in and not at 100% on any applicable window.
    The preferred account is skipped only when it is shown to be full: unreadable limits still open it.
    A pinned account (pool = false) is opened as asked, full or not: it exists to stay separate."""
    order = [r for r in rows if r["name"] not in exclude]
    if prefer:
        pinned = next((r for r in order if r["name"] == prefer and not r["account"].pool), None)
        if pinned:
            return pinned, t("opening", name=pinned["name"], summary=summary(pinned) if "limits" in pinned else t("no_limit_info"))
        order = [r for r in order if r["name"] == prefer] + [r for r in order if r["name"] != prefer and r["account"].pool]
        head = order[0] if order and order[0]["name"] == prefer else None
        if head and "limits" not in head and eligible(head, family):
            return head, t("limits_unreadable", err=head.get("err", "?"), name=head["name"])
    else:
        order = [r for r in order if r["account"].pool]
    known = [r for r in order if "limits" in r and eligible(r, family)]
    unknown = [r for r in order if r.get("email") and "limits" not in r and eligible(r, family)]
    if not known:
        if unknown:
            return unknown[0], t("limits_unreadable", err=unknown[0].get("err", "?"), name=unknown[0]["name"])
        return (order[0] if order else None), t("no_login")
    free = [r for r in known if not usage.blocking(r["limits"], family)]
    if free:
        r = free[0]
        skipped = [k for k in known[: known.index(r)]]
        if not skipped:
            return r, t("opening", name=r["name"], summary=summary(r))
        reasons = "; ".join(f"{k['name']}: {why_blocked(k, family)}" for k in skipped)
        return r, t("skipped", reasons=reasons, name=r["name"], summary=summary(r))
    if unknown:
        return unknown[0], t("all_full_unknown", name=unknown[0]["name"], err=unknown[0].get("err", "?"))

    def earliest(r):
        ts = [usage.parse_ts(lim.get("resets_at")) for lim in usage.blocking(r["limits"], family)]
        ts = [x for x in ts if x]
        return min(ts) if ts else datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)

    r = min(known, key=earliest)
    return r, t("all_full", name=r["name"], why=why_blocked(r, family))


def best(cfg: Config, rows: list[dict], family: str | None = None, exclude=(), min_headroom: float = 0.0) -> dict | None:
    cands = [r for r in rows if r["name"] not in exclude and r["account"].pool and "limits" in r and eligible(r, family)
             and not usage.blocking(r["limits"], family)]
    cands = [r for r in cands if usage.headroom(r["limits"], family) > min_headroom]
    if not cands:
        return None
    return max(cands, key=lambda r: usage.headroom(r["limits"], family))


def warnings(cfg: Config, rows: list[dict]) -> list[str]:
    out = []
    by_email: dict[str, list[str]] = {}
    for r in rows:
        a = r["account"]
        have = r.get("email") or ""
        if a.email and have != a.email:
            out.append(t("drift", name=a.name, dir=a.dir, want=a.email, have=have or t("not_logged_in")))
        if have:
            by_email.setdefault(have, []).append(a.name)
    for em, names in by_email.items():
        if len(names) > 1:
            out.append(t("dup", email=em, n=len(names), dirs=", ".join(names)))
    return out
