---
status: accepted
---

# Recover the full Bash command from the Pi session

> **Mechanism superseded by ADR 0004.** Permission-system 25.3 now exposes the
> complete local Bash input through `PromptPermissionDetails.payload`; the
> wrapper and complete-compound safety rules recorded here remain in force.

`pi-permission-inner-cmd` needs the complete Bash input before it may allow a transparent wrapper. `@gotgenes/pi-permission-system` exposes only the winning command unit as `details.command`; for `timeout 60s pnpm test && git push`, that may be `timeout 60s pnpm test`. An Authorizer `allow` approves the whole tool call, so unwrapping that unit alone could hide a sibling command.

## Decision

For direct calls to Pi's native `bash` tool, capture the session manager at `session_start`. During authorization, walk the session in reverse to the latest assistant message containing a `toolCall` block whose `id` equals `details.toolCallId`, require exactly one such block *within that message*, and read its structured `arguments.command` value.

Proceed only when all evidence agrees:

- the request and recovered tool call both identify the native `bash` tool;
- the tool-call ID has exactly one match within the latest assistant message that contains it (a cross-message reuse resolves to the latest, which is the call being authorized);
- `arguments.command` is a string;
- the ask-triggering unit (`details.command`) matches the wrapper grammar;
- the inner command is not another recognized wrapper.

V0.1 recognizes:

```regex
^timeout[ \t]+([1-9][0-9]*(?:\.[0-9]+)?[smhd]?)[ \t]+(.+)$
```

The duration follows GNU timeout's grammar: a positive number (integer or
decimal) with an optional unit `s`/`m`/`h`/`d` (default seconds), so a bare
integer such as `timeout 240 cmd` is accepted. The duration format is irrelevant
to unwrap soundness — the duration is discarded and only the inner command is
re-evaluated — so the full numeric grammar is allowed. `0`/leading-zero, `ms`,
and flags remain excluded. (Amended from the original unit-required grammar
after `timeout 240 …` was seen in real usage.)

The complete inner command is re-evaluated through the Deterministic Permission Policy. Map `allow` to `allow`, `deny` to `deny`, and `ask` to `defer`. Missing or ambiguous session evidence, forwarded requests, shell aliases, unsupported `timeout` options, nested wrappers, parse failures, and exceptions all produce `defer`.

**Scaffolded commands (amended).** The recovered full command may be a compound
that does not start with the wrapper — e.g. a subagent scaffold
`cd … && timeout … | tail; echo EXIT`. Detection therefore runs on
`details.command` (the unit the permission system isolated, always
wrapper-leading). The wrapper is stripped from the *full* command (the unit
text is replaced by its unwrapped inner, required to occur exactly once) and the
entire de-wrapped compound is re-evaluated through the Deterministic Permission
Policy, which decomposes it into units and keeps the most restrictive — so
sibling commands are still judged and cannot hide behind the wrapper's allow. If
the unit is not a recognized wrapper, cannot be located exactly once, or the
re-evaluation is not `allow`, the authorizer defers fail-closed. (The original
design detected on the full command only, which missed every scaffolded command;
`details.command` is now used for *detection and locating* only — judgment still
runs on the full command, preserving the "never trust a truncated unit" rule.)

## Consequences

This avoids changing permission-system and avoids parsing authorization evidence from the human-facing `details.message`. It deliberately supports fewer contexts: forwarded and non-native shell calls continue through the existing authority chain.

The implementation must retain regression tests for:

- inner `allow`, `ask`, and `deny` mapping;
- compound input such as `timeout 60s pnpm test && git push`;
- unsupported and nested wrapper syntax;
- missing, within-message duplicate, malformed, and forwarded session evidence;
- a tool-call id reused across messages (resolved to the latest);
- Authorizer registration and disposal.

The end-to-end experiment confirmed that permission-system checks every Bash command unit but invokes the Authorizer once for the aggregated `ask`; an Authorizer `allow` then releases the complete tool call. See [context ownership](../research/ai-bash-context-ownership.md) and [minimal Bash judgment evidence](../research/ai-bash-judge-input-minimality.md) for the underlying permission and evidence boundaries.

## Rejected alternatives

- **Treat `details.command` as the full input:** unsafe for compound Bash programs.
- **Parse `details.message`:** fail-closed parsing is possible but couples authorization to UI prose.
- **Add a permission-system API:** structurally clean, but would make this package depend on an unavailable upstream change.
- **Maintain a safe-command allowlist:** duplicates policy and violates the re-evaluation invariant.
