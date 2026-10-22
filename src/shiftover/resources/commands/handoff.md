---
description: Continue this conversation on another account (shiftover). Usage - /handoff [account] [model] [effort]
allowed-tools: Bash(shiftover handoff:*)
---
Run exactly this command with the Bash tool and nothing else:

```
shiftover handoff $ARGUMENTS
```

Arguments map to `shiftover handoff [ACCOUNT] [--model MODEL] [--effort EFFORT]`: a bare word is the account, a word that
names a model (fable, opus, sonnet, haiku or a full model id) goes to `--model`, and low/medium/high/xhigh/max goes to `--effort`.
If the user gave no arguments, run `shiftover handoff` with no arguments.

Then tell the user the command's one-line output and end your turn immediately: the hand-off happens when this turn ends,
and the conversation continues on the other account with the same history.
