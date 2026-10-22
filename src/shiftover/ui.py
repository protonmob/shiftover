"""Terminal table, bars and the arrow-key picker."""
import datetime
import os
import sys

from . import usage
from .i18n import t
from .pick import label

BAR_WIDTH = 10
GAP = "    "


class Style:
    def __init__(self, stream, force: bool = False):
        on = force or bool(getattr(stream, "isatty", lambda: False)()) or bool(os.environ.get("CLICOLOR_FORCE"))
        self.reset, self.bold, self.dim = ("\033[0m", "\033[1m", "\033[2m") if on else ("", "", "")
        self.green, self.yellow, self.red, self.cyan = (
            ("\033[32m", "\033[33m", "\033[31m", "\033[36m") if on else ("", "", "", ""))


def term_cols(out) -> int:
    for fd in ([getattr(out, "fileno", lambda: None)()] if out else []) + [2, 1]:
        try:
            if fd is not None:
                return os.get_terminal_size(fd).columns
        except OSError:
            pass
    try:
        return int(os.environ.get("COLUMNS", ""))
    except ValueError:
        return 200


def cell(lim: dict, st: Style, now):
    used = max(0.0, min(100.0, lim["used"]))
    filled = round(used / 100 * BAR_WIDTH)
    bar = "█" * filled + "░" * (BAR_WIDTH - filled)
    col = st.green if used < 50 else st.yellow if used < 80 else st.red
    rs = usage.reset_in(lim, now)
    plain = f"{bar} {used:3.0f}%" + (f"  ↻ {rs}" if rs else "")
    colored = f"{col}{bar} {used:3.0f}%{st.reset}" + (f"  {st.dim}↻ {rs}{st.reset}" if rs else "")
    return plain, colored


def build_lines(rows, st: Style, selected=None, cols=200):
    now = datetime.datetime.now(datetime.timezone.utc).astimezone()
    labels = {}
    for r in rows:
        for lim in r.get("limits") or []:
            labels.setdefault((lim["kind"], lim.get("model") or ""), label(lim))
    kinds = sorted(labels, key=lambda k: (usage.KINDS.index(k[0]), k[1]))
    name_w = max([len(r["name"]) for r in rows] + [6])
    email_w = max([len(r.get("email") or "") for r in rows] + [len(t("not_logged_in"))])
    cells, widths = {}, {k: len(labels[k]) for k in kinds}
    for i, r in enumerate(rows):
        bykind = {(lim["kind"], lim.get("model") or ""): lim for lim in r.get("limits") or []}
        for k in kinds:
            c = cell(bykind[k], st, now) if k in bykind else ("-", f"{st.dim}-{st.reset}")
            cells[(i, k)] = c
            widths[k] = max(widths[k], len(c[0]))
    wide_w = 5 + name_w + 2 + email_w + sum(len(GAP) + widths[k] for k in kinds)
    narrow = bool(kinds) and wide_w > cols
    out = []

    def num(i, on):
        mark = "›" if on else " "
        return f"{mark}{i + 1:>2}", f"{st.bold}{st.cyan}{mark}{i + 1:>2}{st.reset}"

    def ident(r, on):
        plain = f"{r['name']:<{name_w}}  {(r.get('email') or t('not_logged_in')):<{email_w}}"
        return plain, (f"{st.bold}{st.cyan}{plain}{st.reset}" if on else plain)

    if kinds and not narrow:
        head = f"{'':>3}  {t('col_account'):<{name_w + 2 + email_w}}"
        for k in kinds:
            head += GAP + f"{labels[k].upper():<{widths[k]}}"
        out.append((head, st.dim + head + st.reset))
    for i, r in enumerate(rows):
        out.append(("", ""))
        on = selected == i
        n_p, n_c = num(i, on)
        e_p, e_c = ident(r, on)
        if r.get("err") and "limits" not in r:
            out.append((f"{n_p}  {e_p}{GAP}{r['err']}", f"{n_c}  {e_c}{GAP}{st.yellow}{r['err']}{st.reset}"))
            continue
        if "limits" not in r:
            out.append((f"{n_p}  {e_p}", f"{n_c}  {e_c}"))
            continue
        if narrow:
            out.append((f"{n_p}  {e_p}".rstrip(), f"{n_c}  {e_c}".rstrip()))
            lw = max(len(labels[k]) for k in kinds)
            for k in kinds:
                if (i, k) not in cells or cells[(i, k)][0] == "-":
                    continue
                plain, colored = cells[(i, k)]
                out.append((f"     {labels[k]:<{lw}}  {plain}", f"     {st.dim}{labels[k]:<{lw}}{st.reset}  {colored}"))
            if r.get("extra"):
                out.append((f"     {r['extra']}", f"     {st.dim}{r['extra']}{st.reset}"))
            continue
        plain_line, colored_line = f"{n_p}  {e_p}", f"{n_c}  {e_c}"
        for k in kinds:
            plain, colored = cells[(i, k)]
            padn = widths[k] - len(plain)
            plain_line += GAP + plain + " " * padn
            colored_line += GAP + colored + " " * padn
        if r.get("extra"):
            plain_line += GAP + r["extra"]
            colored_line += GAP + f"{st.dim}{r['extra']}{st.reset}"
        out.append((plain_line.rstrip(), colored_line.rstrip()))
    return out


def screen_rows(plain_lines, cols):
    return sum(max(1, -(-len(ln) // cols)) for ln in plain_lines)


def render(rows, out, selected=None):
    st = Style(out)
    lines = build_lines(rows, st, selected, term_cols(out))
    for _, colored in lines:
        print(colored, file=out)
    return [plain for plain, _ in lines]


def menu(rows, suggested, msg, hint):
    """Arrow-key picker on /dev/tty. Returns 0-based index, -1 on cancel, None if no tty."""
    import select
    import termios
    import tty

    err = sys.stderr
    st = Style(err)
    selectable = [i for i, r in enumerate(rows) if r.get("email")]
    if not selectable:
        return None
    try:
        fd = os.open("/dev/tty", os.O_RDWR)
    except OSError:
        return None
    try:
        cols = os.get_terminal_size(fd).columns
    except OSError:
        cols = term_cols(err)
    cur = suggested if suggested in selectable else selectable[0]
    tone = st.yellow if msg.startswith("⚠") else st.dim

    def draw():
        lines = build_lines(rows, st, selected=cur, cols=cols)
        plain = [p for p, _ in lines] + ["", msg, hint]
        for _, c in lines:
            print(c, file=err)
        print(file=err)
        print(tone + msg + st.reset, file=err)
        print(f"{st.dim}{hint}{st.reset}", file=err)
        err.flush()
        return screen_rows(plain, cols)

    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        err.write("\033[?25l")
        n = draw()
        while True:
            ch = os.read(fd, 1)
            key = None
            if ch == b"\x1b":
                ready, _, _ = select.select([fd], [], [], 0.05)
                seq = os.read(fd, 2) if ready else b""
                key = {b"[A": "up", b"[B": "down", b"": "esc"}.get(seq)
            elif ch in (b"\r", b"\n"):
                key = "enter"
            elif ch in (b"k", b"K"):
                key = "up"
            elif ch in (b"j", b"J"):
                key = "down"
            elif ch in (b"q", b"Q", b"\x03"):
                key = "esc"
            elif ch.isdigit():
                key = int(ch)
            if key == "enter":
                return cur
            if key == "esc":
                return -1
            if isinstance(key, int):
                if 1 <= key <= len(rows) and key - 1 in selectable:
                    return key - 1
                continue
            if key == "up":
                cur = selectable[(selectable.index(cur) - 1) % len(selectable)]
            elif key == "down":
                cur = selectable[(selectable.index(cur) + 1) % len(selectable)]
            else:
                continue
            err.write(f"\033[{n}A\033[J")
            n = draw()
    except KeyboardInterrupt:
        return -1
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        err.write("\033[?25h")
        err.flush()
        os.close(fd)
