---
status: accepted
---

# Recover the full Bash command from the Pi session

`pi-permission-inner-cmd` needs the complete Bash input before it may allow a transparent wrapper. `@gotgenes/pi-permission-system` exposes only the winning command unit as `details.command`; for `timeout 60s pnpm test && git push`, that may be `timeout 60s pnpm test`. An Authorizer `allow` approves the whole tool call, so unwrapping that unit alone could hide a sibling command.

## Decision

For direct calls to Pi's native `bash` tool, capture the session manager at `session_start`. During authorization, walk the session in reverse to the latest assistant message containing a `toolCall` block whose `id` equals `details.toolCallId`, require exactly one such block *within that message*, and read its structured `arguments.command` value.

Proceed only when all evidence agrees:

- the request and recovered tool call both identify the native `bash` tool;
- the tool-call ID has exactly one match within the latest assistant message that contains it (a cross-message reuse resolves to the latest, which is the call being authorized);
- `arguments.command` is a string;
- the complete input matches the strict wrapper grammar;
- the inner command is not another recognized wrapper.

V0.1 recognizes only:

```regex
^timeout[ \t]+([1-9][0-9]*[smhd])[ \t]+(.+)$
```

The complete inner command is re-evaluated through the Deterministic Permission Policy. Map `allow` to `allow`, `deny` to `deny`, and `ask` to `defer`. Missing or ambiguous session evidence, forwarded requests, shell aliases, unsupported `timeout` options, nested wrappers, parse failures, and exceptions all produce `defer`.

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
