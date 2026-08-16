---
status: accepted
---

# Read the full Bash command from the structured prompt payload

ADR 0001 recovered Pi's native Bash tool input by walking the captured session.
That was necessary with `@gotgenes/pi-permission-system` 24.0.0, where an
Authorizer received only the winning command unit as structured data.

Permission-system 25.3.0 introduced a required, complete
`PromptPermissionDetails.payload`. For a local Bash ask it represents:

- `payload.request.value`: the command unit whose rule produced the ask;
- `payload.request.executedUnit`: a display-only inner unit shown as `runs`;
- `payload.evidence` entry labelled `full command`: the complete native Bash
  input when it differs from `request.value`.

The builder deliberately omits `full command` when the complete input equals
`request.value`, so absence is a deduplication case rather than automatically a
missing-evidence case.

## Decision

Require `@gotgenes/pi-permission-system >=25.3.0` and consume its structured
payload directly. A command is eligible only for a local, native Bash payload:

- `payload.kind`, `payload.request.surface`, `details.toolName`, and
  `payload.request.toolName` all identify `bash`;
- neither the legacy forwarding field nor structured requester marks it as
  forwarded;
- `payload.request.invokedToolName` is `null`, excluding shell aliases;
- `payload.request.value` is non-blank and agrees with the legacy command
  projection when that projection is present.

Select the complete command as follows:

1. Exactly one non-blank `full command` evidence entry: use its text.
2. No such entry: use the non-blank `request.value`, relying on the 25.3 builder's
   equality-deduplication contract.
3. Duplicate, blank, inconsistent, forwarded, aliased, or malformed evidence:
   defer fail-closed.

`request.value` remains the triggering unit used to locate a transparent wrapper
inside the complete input. An Authorizer verdict still applies to the whole tool
call, so deterministic re-evaluation must continue to cover the complete
unwrapped compound and all sibling commands.

Forwarded asks in 25.3/25.4 remain out of scope. Their serving-side payload has
kind `forwarded` and carries the child's legacy request prose as `requested`
evidence; it does not preserve a separately structured child full command.
Consumers must defer and must not parse that prose.

## Consequences

The session tool-call walker, its tests, and the
`@sikongjueluo/pi-permission-shared` package are removed. Root session capture is
still retained where needed for registration ownership and session-identity
revalidation; removing command recovery does not make process-global service
ownership safe by itself.

The AI Judge can now call a model with the exact local Bash input without parsing
UI text. Its initial integration remains Shadow-only: structured predictions are
recorded as metadata and the Authorizer always returns `defer`.

This supersedes only ADR 0001's session-recovery mechanism. ADR 0001's wrapper
recognition, complete-compound re-evaluation, and fail-closed rules remain in
force.
