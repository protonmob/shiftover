LANG = "en"

STRINGS = {
    "en": {
        "col_account": "ACCOUNT",
        "l_session": "5h",
        "l_week": "week",
        "l_week_model": "week·{model}",
        "not_logged_in": "(not logged in)",
        "limits_unreadable": "limits unreadable ({err}) → opening {name}",
        "no_login": "no account is logged in",
        "opening": "→ {name} ({summary})",
        "skipped": "⚠ {reasons} → opening {name} ({summary})",
        "full": "{label} full",
        "resets_in": "resets in {t}",
        "used_summary": "{label} {used}% used",
        "no_limit_info": "no limit info",
        "all_full_unknown": "⚠ known accounts are full, {name} is unreadable ({err}) → trying it",
        "all_full": "⚠ all accounts are full; opening {name}, which resets first ({why})",
        "menu_hint": "↑↓ select · Enter open · 1-9 direct · q cancel",
        "switch_hint": "↑↓ select · Enter continue · 1-9 direct · q quit",
        "switch_msg": "{name} closed · continue this conversation with another account",
        "cancelled": "cancelled",
        "drift": "⚠ {name} ({dir}) should hold {want}, now {have} — open it and /login as {want}",
        "dup": "⚠ {email} is logged into {n} dirs ({dirs}) — one of them should be another account",
        "handoff_line": "↪ {src}: {reason} → continuing on {dst}{detail}",
        "handoff_none": "⚠ {src}: {reason}; no other account has headroom, Claude Code will wait for the reset",
        "invalid_account": "unknown account: {spec}",
        "no_claude": "claude binary not found on PATH (set SHIFTOVER_CLAUDE_BIN)",
        "no_config": "no config yet: run `shiftover init --import`",
        "disabled": "(disabled)",
    },
    "tr": {
        "col_account": "HESAP",
        "l_session": "5 saat",
        "l_week": "hafta",
        "l_week_model": "hafta·{model}",
        "not_logged_in": "(giriş yok)",
        "limits_unreadable": "limitler okunamadı ({err}) → {name} ile açılıyor",
        "no_login": "hiçbir hesapta giriş yok",
        "opening": "→ {name} ({summary})",
        "skipped": "⚠ {reasons} → {name} ile açılıyor ({summary})",
        "full": "{label} dolu",
        "resets_in": "{t} sonra açılır",
        "used_summary": "{label} %{used} harcandı",
        "no_limit_info": "limit bilgisi yok",
        "all_full_unknown": "⚠ bilinen hesaplar dolu, {name} okunamadı ({err}) → onunla deneniyor",
        "all_full": "⚠ tüm hesaplar dolu; en erken açılan {name} ({why}) ile açılıyor",
        "menu_hint": "↑↓ seç · Enter aç · 1-9 direkt · q iptal",
        "switch_hint": "↑↓ seç · Enter devam et · 1-9 direkt · q kapat",
        "switch_msg": "{name} kapandı · bu konuşmaya başka hesapla devam et",
        "cancelled": "iptal",
        "drift": "⚠ {name} ({dir}) {want} olmalı, şu an {have} — o dizini açıp /login ile {want} hesabına gir",
        "dup": "⚠ {email} {n} dizinde ({dirs}) — biri başka hesap olmalı",
        "handoff_line": "↪ {src}: {reason} → {dst} ile devam ediliyor{detail}",
        "handoff_none": "⚠ {src}: {reason}; başka hesapta yer yok, Claude Code reset'i bekleyecek",
        "invalid_account": "geçersiz hesap: {spec}",
        "no_claude": "claude PATH'te bulunamadı (SHIFTOVER_CLAUDE_BIN ayarla)",
        "no_config": "config yok: `shiftover init --import` çalıştır",
        "disabled": "(kapalı)",
    },
}


def set_lang(lang: str | None) -> None:
    global LANG
    LANG = lang if lang in STRINGS else "en"


def t(key: str, **kw) -> str:
    s = STRINGS.get(LANG, {}).get(key) or STRINGS["en"][key]
    return s.format(**kw) if kw else s
