# pi-extensions

Personal `pi` coding-agent extensions. This context covers the permission
extensions that inspect and re-evaluate Bash commands before they are allowed.

## Language

### Authority

**Enforce authority**:
Allow-only delegation under a user-assumed-risk contract (ADR 0008):
writing `mode: "enforce"` in config v2 consents to the selected judge model
approving ordinary operations on the user's behalf. When the Judge's verdict
is `allow` and every fail-closed health gate in the Enforce truth table
passes (audit, telemetry, result kind, review acknowledgement,
generation-current), the command runs without the human dialog. The Judge can
never answer `deny` with authority; every uncertain case (defer, deny,
preflight, infrastructure failure) falls back to the human dialog.
_Avoid_: model safety certification (dropped — see ADR 0008), AI takeover,
auto-deny, full delegation

**Audit log (Judge-owned)**:
The Enforce-era accountability record written by the Judge package itself —
separate file from the permission-system review log, append + fsync per
record, self-checked for health; an unhealthy audit log refuses authority.
_Avoid_: host contract (dropped — see ADR 0006), acknowledged write (upstream
sense)

**High-risk override**:
A narrow code-level preflight recognizing clear-cut command shapes in four
categories — data loss/history rewrite, publish/deploy/infrastructure
destruction, privilege escalation/system modification, direct credential
access — that always defers to the human dialog regardless of verdict. In
Enforce it skips the model call entirely; in Shadow the model is still called
for quality observation. Deliberately not a sandbox: only well-known explicit
shapes, no alias/script/variable analysis, no `alwaysPrompt` config.
_Avoid_: command sandbox, alwaysPrompt, opaque-command blanket defer

**Irreversibility boundary**:
An allow verdict requires every operation's effects to be recoverable —
reversible, or reproducible from the repository or the evidence at hand.
An operation that destroys data which cannot be re-created or undone
(unscoped untracked/ignored deletion, discarding uncommitted work,
rewriting published history) always defers to the human dialog, no matter
how specifically the user requested it; sensitivity alone (e.g. credential
refresh) is not irreversibility. Explicit intent grants allow authority
only over recoverable effects.
_Avoid_: destructive-but-requested allow (v3 sense — see ADR 0007),
risk-based deny

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
