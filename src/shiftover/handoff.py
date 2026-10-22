"""Hand the running conversation to another account at the end of the current turn."""
import os
import signal

from . import paths, runstate
from .config import Config


class HandoffError(Exception):
    pass


def apply(rd, request: dict) -> None:
    paths.write_json(rd / "handoff.json", request)
    (rd / "pending.json").unlink(missing_ok=True)
    pid = runstate.wrapper_pid()
    if pid:
        os.kill(pid, signal.SIGUSR1)


def schedule(cfg: Config, spec: str | None, model: str | None, effort: str | None, now: bool = False) -> str:
    rd = runstate.run_dir()
    if not rd:
        raise HandoffError("this session was not started through `shiftover run`, so it cannot be handed off")
    target = None
    if spec:
        target = cfg.resolve(spec)
        if not target:
            raise HandoffError(f"unknown account: {spec}")
        if target.name == os.environ.get("SHIFTOVER_ACCOUNT"):
            raise HandoffError(f"already on {target.name}")
    req = {"target": target.name if target else "", "model": model, "effort": effort, "reason": "manual hand-off"}
    if now:
        if not req["target"]:
            raise HandoffError("--now needs an explicit account")
        apply(rd, req)
        return f"Handing off to {target.name} now."
    paths.write_json(rd / "pending.json", req)
    who = target.name if target else "the account with the most headroom"
    return f"Hand-off to {who} is scheduled for the end of this turn."
