"""Which account to open or hand work to."""
import datetime
import random

from . import usage
from .config import Config
from .i18n import t

LABELS = {"session": "l_session", "weekly_all": "l_week", "weekly_scoped": "l_week_model"}


def label(lim: dict) -> str:
    return t(LABELS[lim["kind"]], model=lim.get("model") or "model")


def rows_for(cfg: Config, entries: dict) -> list[dict]:
    rows = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for a in cfg.ordered():
        e = entries.get(str(a.path)) or {}
        row = {"account": a, "name": a.name, "display": a.display or None, "email": e.get("email") or a.email,
               "dir": str(a.path)}
        row["fetched_at"] = e.get("ts")
        nxt = usage.next_refresh(e)
        # Jittered so the tabs polling `status --json` do not all wake in the same second.
        row["next_refresh_at"] = nxt + random.uniform(0, usage.JITTER) if nxt is not None else None
        if not e.get("email"):
            row["err"] = "not logged in"
            row["email"] = ""
        elif e.get("err"):
            row["err"] = usage.error(e)
        if "limits" in e:
            lims = e["limits"]
            if e.get("err"):
                # Kept through a failed read: they still decide, minus windows that have reset since.
                lims = [lim for lim in lims if not usage.reset_passed(lim, now)]
            row["limits"] = lims
            row["limits_fetched_at"] = e.get("limits_ts", e.get("ts"))
        if e.get("extra"):
            row["extra"] = e["extra"]
        rows.append(row)
    return rows


def shown(row: dict) -> str:
    """The account as messages name it: its display name when set."""
    return row.get("display") or row["name"]


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
            return pinned, t("opening", name=shown(pinned), summary=summary(pinned) if "limits" in pinned else t("no_limit_info"))
        order = [r for r in order if r["name"] == prefer] + [r for r in order if r["name"] != prefer and r["account"].pool]
        head = order[0] if order and order[0]["name"] == prefer else None
        if head and "limits" not in head and eligible(head, family):
            return head, t("limits_unreadable", err=head.get("err", "?"), name=shown(head))
    else:
        order = [r for r in order if r["account"].pool]
    known = [r for r in order if "limits" in r and eligible(r, family)]
    unknown = [r for r in order if r.get("email") and "limits" not in r and eligible(r, family)]
    if not known:
        if unknown:
            return unknown[0], t("limits_unreadable", err=unknown[0].get("err", "?"), name=shown(unknown[0]))
        return (order[0] if order else None), t("no_login")
    free = [r for r in known if not usage.blocking(r["limits"], family)]
    if free:
        r = free[0]
        skipped = [k for k in known[: known.index(r)]]
        if not skipped:
            return r, t("opening", name=shown(r), summary=summary(r))
        reasons = "; ".join(f"{shown(k)}: {why_blocked(k, family)}" for k in skipped)
        return r, t("skipped", reasons=reasons, name=shown(r), summary=summary(r))
    if unknown:
        return unknown[0], t("all_full_unknown", name=shown(unknown[0]), err=unknown[0].get("err", "?"))

    def earliest(r):
        ts = [usage.parse_ts(lim.get("resets_at")) for lim in usage.blocking(r["limits"], family)]
        ts = [x for x in ts if x]
        return min(ts) if ts else datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)

    r = min(known, key=earliest)
    return r, t("all_full", name=shown(r), why=why_blocked(r, family))


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
