"""A stdio MCP server exposing the account pool to the session that spawned it."""
import json
import os
import sys

from .. import __version__, claude, config, pick, usage
from . import jobs

PROTOCOL = "2025-06-18"
SUPPORTED = {"2025-06-18", "2025-03-26", "2024-11-05"}
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
PERMS = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]

TOOLS = [
    {
        "name": "accounts",
        "description": "List the pooled Claude Code accounts with their 5-hour / weekly usage windows, per-model windows, "
                       "headroom and live sessions. Read-only; uses a short cache.",
        "inputSchema": {"type": "object", "properties": {
            "refresh": {"type": "boolean", "description": "Bypass the cache (one network call per account)."}}},
    },
    {
        "name": "delegate",
        "description": "Run a self-contained task as a headless Claude Code session on another account and return its answer. "
                       "The delegate sees only the prompt, has no claude.ai connectors and nobody answers its permission prompts. "
                       "Long tasks: background=true, then monitor.",
        "inputSchema": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "The complete task: goal, paths, constraints, expected output format."},
            "account": {"type": "string", "description": "Account name, 'auto' (most headroom for the model; default) or 'self'."},
            "model": {"type": "string", "description": "fable | opus | sonnet | haiku or a full model id. Default: the account's default."},
            "effort": {"type": "string", "enum": EFFORTS},
            "cwd": {"type": "string", "description": "Working directory for the delegate. Default: this project."},
            "background": {"type": "boolean", "description": "Return a job_id immediately; collect with monitor."},
            "wait_seconds": {"type": "integer", "description": "Foreground wait before the job is backgrounded (default from config, max 600)."},
            "permission_mode": {"type": "string", "enum": PERMS, "description": "acceptEdits for tasks that write files."},
            "allowed_tools": {"type": "array", "items": {"type": "string"}, "description": "Extra tool allow-rules, e.g. [\"Bash(npm test:*)\"]."},
            "mcp": {"type": "string", "enum": ["none", "main"], "description": "main: give the delegate the main account's local MCP servers."},
            "json_schema": {"type": "object", "description": "Structured-output schema; the result is then JSON text."},
            "max_budget_usd": {"type": "number"},
            "resume_session_id": {"type": "string", "description": "Continue an earlier delegate session instead of starting fresh."},
            "label": {"type": "string", "description": "Short label for job lists."},
        }, "required": ["prompt"]},
    },
    {
        "name": "monitor",
        "description": "Status and results of delegate jobs. Without job_ids lists recent jobs. wait_seconds blocks for running jobs; cancel stops them.",
        "inputSchema": {"type": "object", "properties": {
            "job_ids": {"type": "array", "items": {"type": "string"}},
            "wait_seconds": {"type": "integer"},
            "cancel": {"type": "boolean"},
        }},
    },
]


class ToolError(Exception):
    pass


def _text(obj, is_error=False):
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, indent=1)}], "isError": is_error}


class Server:
    def __init__(self):
        self.cfg = config.load_or_none()
        self.cur = self.cfg.by_dir(claude.current_dir()) if self.cfg else None

    def _need_cfg(self):
        if not self.cfg or not self.cfg.accounts:
            raise ToolError("shiftover has no config: run `shiftover init --import` first")
        return self.cfg

    def accounts(self, args: dict):
        cfg = self._need_cfg()
        entries = usage.refresh([a.path for a in cfg.ordered()], ttl=60, force=bool(args.get("refresh")), budget=10)
        out = []
        for r in pick.rows_for(cfg, entries):
            a = r["account"]
            d = {"name": a.name, "email": r.get("email") or "", "is_current": bool(self.cur and a.name == self.cur.name),
                 "live_sessions": len(claude.live_sessions(a.path))}
            if a.models:
                d["models"] = a.models
            if "limits" in r:
                d["headroom"] = usage.headroom(r["limits"])
                d["windows"] = [{"kind": lim["kind"], "model": lim.get("model") or None, "used_percent": lim["used"],
                                 "resets_in": usage.reset_in(lim) or None} for lim in r["limits"]]
            else:
                d["error"] = r.get("err", "unknown")
            out.append(d)
        return out

    def _pick_account(self, cfg, spec: str, family: str | None):
        spec = (spec or "auto").strip()
        if spec == "auto":
            rows = pick.rows_for(cfg, usage.refresh([a.path for a in cfg.ordered()], ttl=60, budget=10))
            row = pick.best(cfg, rows, family, exclude=(self.cur.name,) if self.cur else ())
            if not row:
                row = pick.best(cfg, rows, family)
            if not row:
                raise ToolError("no account has headroom for this task right now")
            return row["account"]
        if spec in ("self", "current"):
            if not self.cur:
                raise ToolError("cannot tell which account this session runs on")
            return self.cur
        acct = cfg.resolve(spec)
        if not acct:
            raise ToolError(f"unknown account: {spec}; known: {', '.join(cfg.accounts)}")
        return acct

    def delegate(self, args: dict):
        if os.environ.get("SHIFTOVER_DEPTH") == "1":
            raise ToolError("this session is itself a delegate; delegates cannot delegate")
        cfg = self._need_cfg()
        prompt = args.get("prompt") or ""
        if not prompt.strip():
            raise ToolError("prompt is required")
        if len(prompt) > 256 * 1024:
            raise ToolError("prompt is larger than 256 KiB; put the material in a file and reference its path")
        model = args.get("model") or None
        effort = args.get("effort") or None
        if effort and effort not in EFFORTS:
            raise ToolError(f"effort must be one of {EFFORTS}")
        perm = args.get("permission_mode") or cfg.delegate_permission_mode or "default"
        if perm not in PERMS:
            raise ToolError(f"permission_mode must be one of {PERMS}")
        if perm == "bypassPermissions" and not cfg.delegate_allow_bypass:
            raise ToolError("bypassPermissions is disabled; set delegate.allow_bypass = true in the shiftover config to allow it")
        acct = self._pick_account(cfg, args.get("account") or "auto", usage.model_family(model))
        mcp_mode = args.get("mcp") or cfg.delegate_mcp or "none"
        mcp_servers = None
        if mcp_mode == "main":
            main = cfg.main_account()
            mcp_servers = {k: v for k, v in claude.mcp_servers(main.path).items() if k != "shiftover"} if main else None
        wait_s = args.get("wait_seconds")
        wait_s = cfg.delegate_wait if wait_s is None else max(0, min(int(wait_s), 600))
        job = jobs.start(acct, prompt, model=model, effort=effort, cwd=args.get("cwd") or None, permission_mode=perm,
                         allowed_tools=args.get("allowed_tools") or None, json_schema=args.get("json_schema") or None,
                         max_budget_usd=args.get("max_budget_usd"), resume_session_id=args.get("resume_session_id") or None,
                         label=args.get("label") or "", mcp_servers=mcp_servers)
        if not args.get("background"):
            job = jobs.wait(job, wait_s)
        out = jobs.summary(job)
        if job.status == "running":
            out["note"] = f"still running after {wait_s}s; collect with monitor(job_ids=[\"{job.id}\"])"
        if job.session_id:
            out["resume_hint"] = f"delegate(resume_session_id=\"{job.session_id}\", account=\"{acct.name}\", prompt=...)"
        return out

    def monitor(self, args: dict):
        ids = args.get("job_ids") or []
        wait_s = max(0, min(int(args.get("wait_seconds") or 0), 600))
        if not ids:
            return [jobs.summary(jobs.refresh(j), max_chars=400) for j in jobs.list_all()[:20]]
        out = []
        for jid in ids:
            j = jobs.load(jid)
            if not j:
                out.append({"job_id": jid, "status": "unknown"})
                continue
            if args.get("cancel"):
                j = jobs.cancel(j)
            elif wait_s:
                j = jobs.wait(j, wait_s)
            else:
                j = jobs.refresh(j)
            out.append(jobs.summary(j))
        return out

    def call(self, name: str, args: dict):
        fn = {"accounts": self.accounts, "delegate": self.delegate, "monitor": self.monitor}.get(name)
        if not fn:
            raise ToolError(f"unknown tool: {name}")
        return fn(args or {})


def _send(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve() -> int:
    server = Server()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            _send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        mid, method, params = msg.get("id"), msg.get("method") or "", msg.get("params") or {}
        if method.startswith("notifications/"):
            continue
        try:
            if method == "initialize":
                want = params.get("protocolVersion")
                result = {"protocolVersion": want if want in SUPPORTED else PROTOCOL,
                          "capabilities": {"tools": {"listChanged": False}},
                          "serverInfo": {"name": "shiftover", "version": __version__}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                try:
                    result = _text(server.call(params.get("name") or "", params.get("arguments") or {}))
                except ToolError as e:
                    result = _text({"error": str(e)}, is_error=True)
                except Exception as e:  # noqa: BLE001 - report instead of killing the server
                    result = _text({"error": f"{type(e).__name__}: {e}"}, is_error=True)
            elif method in ("resources/list", "prompts/list", "resources/templates/list"):
                result = {method.split("/")[0]: []} if method != "resources/templates/list" else {"resourceTemplates": []}
            else:
                if mid is not None:
                    _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})
                continue
        except Exception as e:  # noqa: BLE001
            if mid is not None:
                _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)}})
            continue
        if mid is not None:
            _send({"jsonrpc": "2.0", "id": mid, "result": result})
    return 0
