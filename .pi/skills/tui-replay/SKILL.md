---
name: tui-replay
description: Drive a background pi TUI session (pty) through the ai-bash-judge permission replay cohort — start interactive pi with bg_start, send prompts/confirmations with bg_send, pair permission-review log rows by requestId, analyze fixed time windows. Use when asked to test/replay/validate the ai-bash-judge pipe, collect shadow cohort rows, or run the 30-command TUI test flow in this repo.
---

# TUI replay for ai-bash-judge

The authoritative protocol lives in this repo:

**`docs/testing/tui-replay.md`** — read it fully before operating. It
defines preconditions (cwd, chain config, timeout cohort), the
bg_start/bg_send control protocol (text and `<Enter>` are separate
sends; `y`×2 approve, `r`×2 + reason + `<Enter>` deny), the
per-command wait/blind-deny ordering, the round procedure with
`--after/--before` windows, the 30-command scenario matrix, pass
criteria (pipe health, not verdict agreement), and the known-pitfalls
list (sandbox EBUSY stubs, `jj squash` editor hang, agent-layer
rewrites, session-rule pollution).

Summary of the loop:

1. Precondition check: TUI cwd = repo root (project override wires the
   judge chain); judge config timeout cohort set.
2. `date -u` round start → fresh TUI via `bg_start` (pty=true) →
   commands one prompt at a time → answer dialogs per doc §3
   (destructive scenarios: blind deny **before** reading the judge row).
3. Quit → `date -u` round end → analyzer CLI on the fixed window →
   archive report under `docs/testing/rounds/`.
4. Gate = join completeness + analyzer-clean + no unexpected infra
   failures + no evidence leaks (doc §7).
