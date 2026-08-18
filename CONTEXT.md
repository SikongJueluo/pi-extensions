# pi-extensions

Personal `pi` coding-agent extensions. This context covers the permission
extensions that inspect and re-evaluate Bash commands before they are allowed.

## Language

### Authority

**Enforce authority**:
Allow-only delegation — when the Judge's verdict is `allow` and every gate in
the Enforce truth table passes, the command runs without the human dialog. The
Judge can never answer `deny` with authority; every uncertain case (defer,
deny, preflight, infrastructure failure) falls back to the human dialog.
_Avoid_: AI takeover, auto-deny, full delegation

**Audit log (Judge-owned)**:
The Enforce-era accountability record written by the Judge package itself —
separate file from the permission-system review log, append + fsync per
record, self-checked for health; an unhealthy audit log refuses authority.
_Avoid_: host contract (dropped — see ADR 0006), acknowledged write (upstream
sense)

### Wrappers

**Wrapper**:
A Bash command of the form `<program> [modifier-args] <inner-command>`, where the
authorization question is "what does the inner command do?". Whether a wrapper
may be unwrapped depends on whether its modifier args are transparent.
_Avoid_: command type, prefix command

**Transparent wrapper**:
A wrapper whose modifier args do not change which program the inner command
resolves to or its trust boundary (e.g. `timeout`). Stripping the modifiers and
re-evaluating the inner command is sound: the verdict applies to the same
program that actually runs.
_Avoid_: safe wrapper

**Non-transparent wrapper**:
A wrapper whose modifiers change what the inner command actually does in a way
the command string does not capture — e.g. `env` (its `PATH=` / `LD_PRELOAD`
make the inner name resolve to or load a different program) or `xargs` (its
inner command's arguments are read from stdin). Stripping the modifiers and
re-evaluating the inner command is unsound: the verdict applies to inputs that
are not knowable from the command string.
_Avoid_: unsafe wrapper
