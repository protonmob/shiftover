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
        "setup_found": "I found {n} Claude Code accounts on this machine:",
        "setup_found_1": "I found one Claude Code account on this machine:",
        "setup_found_none": "No signed-in Claude Code account found (looked in ~/.claude and ~/.claude-*).\nRun `claude` once, sign in, then run `shiftover setup` again.",
        "setup_new": "new",
        "setup_ask": "Which one is your main account?\n`claude` will always open it; the others step in when it runs out of usage.",
        "setup_ask_prompt": "Main account [{default}]: ",
        "setup_not_account": "  {raw} is not one of the accounts above — type a number or a name.",
        "setup_done": "Done. What changed:",
        "setup_b_claude": "`claude` opens {main}. `claude --menu` lets you pick an account by hand.",
        "setup_b_handoff": "When {main} runs out, your conversation continues on another account by itself.",
        "setup_b_inside": "Inside Claude: type /handoff to switch, or ask Claude to \"delegate\" a task to another account.",
        "setup_b_status": "The status line shows how much of each account is used.",
        "setup_b_settings": "Your Claude settings were backed up first ({backup}).",
        "setup_shell_manual": "I could not find your shell's startup file. Add this line to it yourself:\n  {line}",
        "setup_one_account": "Only one account so far: switching needs a second one. `shiftover add <name>` signs one in; then run `shiftover setup` again.",
        "setup_open_tab": "Open a new terminal tab to start.",
        "setup_more": "`shiftover status` shows all accounts.  `shiftover uninstall` undoes everything.",
        "setup_ask_out": "Should any account stay out of the pool, e.g. a work account? It is then opened only when you ask for it\nand never used for a hand-off or a delegate. Numbers or names, Enter for none.",
        "setup_ask_out_prompt": "Keep out [none]: ",
        "setup_main_out": "  {name} is the main account and cannot be kept out.",
        "setup_b_pinned": "{names}: kept separate. Opens with `claude -a {first}` or a folder rule (`shiftover map add <dir> {first}`); never a hand-off or delegate target.",
        "setup_b_codex": "The OpenAI Codex CLI is installed ({version}); Claude can delegate to it too (account \"codex\").",
        "setup_noninteractive": "There is no terminal to ask in. Re-run with the main account named: `shiftover setup --main <name>` (names above).",
        "setup_bad_main": "{raw} is not an account; choose one of: {names}",
        "setup_warn_mcp": "⚠ The delegate tool could not be registered for {names}: {err}\n  Fix that, then run `shiftover install`.",
        "handoff_invisible": "⚠ {dst} cannot see this conversation (projects/ is not shared); staying on {src}",
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
        "setup_found": "Bu bilgisayarda {n} Claude Code hesabı buldum:",
        "setup_found_1": "Bu bilgisayarda 1 Claude Code hesabı buldum:",
        "setup_found_none": "Giriş yapılmış Claude Code hesabı bulamadım (~/.claude ve ~/.claude-* dizinlerine baktım).\nBir kez `claude` çalıştırıp giriş yap, sonra `shiftover setup` komutunu tekrar çalıştır.",
        "setup_new": "yeni",
        "setup_ask": "Hangisi ana hesabın?\n`claude` her zaman onu açar; limiti dolunca diğerleri devreye girer.",
        "setup_ask_prompt": "Ana hesap [{default}]: ",
        "setup_not_account": "  {raw} yukarıdaki hesaplardan değil — numara ya da ad yaz.",
        "setup_done": "Bitti. Ne değişti:",
        "setup_b_claude": "`claude` artık {main} ile açılır. `claude --menu` ile elle hesap seçersin.",
        "setup_b_handoff": "{main} dolunca konuşman kendiliğinden başka hesapta devam eder.",
        "setup_b_inside": "Claude içinde: /handoff ile hesap değiştir, ya da Claude'dan bir işi başka hesaba \"delegate\" etmesini iste.",
        "setup_b_status": "Durum satırında her hesabın ne kadarının kullanıldığını görürsün.",
        "setup_b_settings": "Önce Claude ayarlarının yedeği alındı ({backup}).",
        "setup_shell_manual": "Kabuğunun başlangıç dosyasını bulamadım. Şu satırı kendin ekle:\n  {line}",
        "setup_one_account": "Şimdilik tek hesap var: geçiş için ikinci hesap gerekir. `shiftover add <ad>` ile giriş yap, sonra `shiftover setup` komutunu tekrar çalıştır.",
        "setup_open_tab": "Başlamak için yeni bir terminal sekmesi aç.",
        "setup_more": "`shiftover status` tüm hesapları gösterir.  `shiftover uninstall` her şeyi geri alır.",
        "setup_ask_out": "Havuz dışında kalması gereken hesap var mı, örneğin iş hesabı? O hesap yalnızca sen istediğinde açılır,\ndevretme ve delegate için hiç kullanılmaz. Numara ya da ad yaz, yoksa Enter.",
        "setup_ask_out_prompt": "Dışarıda kalacak [yok]: ",
        "setup_main_out": "  {name} ana hesap, dışarıda bırakılamaz.",
        "setup_b_pinned": "{names}: ayrı tutuluyor. `claude -a {first}` ile ya da klasör kuralıyla açılır (`shiftover map add <dizin> {first}`); devretme ve delegate ona gitmez.",
        "setup_b_codex": "OpenAI Codex CLI kurulu ({version}); Claude ona da iş verebilir (hesap adı \"codex\").",
        "setup_noninteractive": "Soru soracak terminal yok. Ana hesabı adıyla ver: `shiftover setup --main <ad>` (adlar yukarıda).",
        "setup_bad_main": "{raw} bir hesap değil; şunlardan birini seç: {names}",
        "setup_warn_mcp": "⚠ delegate aracı {names} için kaydedilemedi: {err}\n  Bunu düzeltip `shiftover install` çalıştır.",
        "handoff_invisible": "⚠ {dst} bu konuşmayı göremiyor (projects/ paylaşılmamış); {src} ile devam ediliyor",
    },
}


def system_lang() -> str:
    """Picks the UI language from the OS locale when no config exists yet."""
    import os
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        v = os.environ.get(var, "")
        if v:
            return "tr" if v.lower().startswith("tr") else "en"
    return "en"


def set_lang(lang: str | None) -> None:
    global LANG
    LANG = lang if lang in STRINGS else "en"


def t(key: str, **kw) -> str:
    s = STRINGS.get(LANG, {}).get(key) or STRINGS["en"][key]
    return s.format(**kw) if kw else s
