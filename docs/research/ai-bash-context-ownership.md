# Research: context ownership for forwarded and subagent Bash asks

## Scope

This report describes the installed runtime inspected on 2026-08-08:

- `@gotgenes/pi-permission-system` 24.0.0
- `pi-subagents` 0.43.0
- the current `packages/pi-permission-ai-judge/src/index.ts`

Only first-party source, package documentation, and Pi API declarations are used. Product implementation remains out of scope.

## Executive answer

An external permission-system `Authorizer` callback receives only `(details, query, log)`. It receives **no ask-time `ExtensionContext`**. Any conversation it reads therefore belongs to the extension lifecycle context captured when that callback was registered.

For a direct primary-session Bash ask, the root permission-system composes its configured authorizer links before `LocalUserAuthorizer`. A Judge registered by the UI-present root may safely identify the captured `sessionManager` as the primary conversation.

A child ask has two distinct possible authorizer-chain phases:

1. The child's own permission session composes child-local links before its terminal `ParentAuthorizer`.
2. If the child reaches `ParentAuthorizer`, the request is written to the serving session. The serving `ForwardedRequestServer` resolves serving policy and, when the result is still `ask`, composes the serving session's links before its terminal authorizer.

A future Judge must therefore bind only from the UI-present root/service-owning lifecycle context. Otherwise a separately registered child link could judge with child context, or a registered in-process child could capture child context while accidentally registering its callback into the parent's process-global service.

For a forwarded ask handled by the root link, the captured conversation is the **serving root's conversation**, not the requester's child transcript. Link-visible child provenance is `details.forwarding`; there is no cross-session API for reading the child's conversation.

## Proven call flows

### Direct primary Bash ask

1. The primary tool call reaches the primary permission gate.
2. Deterministic policy returns `ask`.
3. `AuthorizerSelection.escalate()` resolves configured links and composes them before the selected terminal.
4. The root Judge link may return `allow`, `deny`, or `defer`.
5. `defer` continues to `LocalUserAuthorizer`; it is not a denial.

The Judge callback may use a root `ExtensionContext` captured at `session_start`, but that context is closure state rather than an argument to `authorize()`.

### Child ask forwarded to the root

1. The child's deterministic policy returns `ask`.
2. The child's `AuthorizerSelection` first runs links registered in that child session, if any.
3. If all links defer or no link exists, the child terminal `ParentAuthorizer` resolves a target session, writes a `ForwardedPermissionRequest`, and polls for a response.
4. The UI-present root's `ForwardingManager` drains the target session inbox.
5. `ForwardedRequestServer` resolves the child-fixed access intent against serving policy.
6. A serving-policy `allow` or `deny` completes without the root chain. A serving-policy `ask` is projected into `PromptPermissionDetails` and passed to the root `AuthorizerSelection`.
7. Root links run before `LocalUserAuthorizer`. A root Judge therefore sees root-captured conversation plus forwarded provenance, not child conversation.
8. The root writes the decision; the child receives it and resumes or blocks.

`ParentAuthorizer` always uses filesystem request/response transport, including registered in-process children. The registry resolves identity and parentage; it is not an in-memory response fast path.

### Nested children

Depth alone does not determine the result. A request targeting a headless immediate parent will normally remain unserved and time out. A request routed directly to the UI-present root can still be served. The server warns on a detected multi-hop mismatch but deliberately continues processing a correctly targeted request.

## What an authorizer link can actually see

| Evidence | Direct primary ask | Parent-side forwarded ask |
|---|---|---|
| `details.forwarding` | absent | requester agent/session, possibly nullable for version-skew data |
| `details.agentName` | active primary agent | requesting child agent |
| `details.surface` / `details.value` | usually derived fields are absent on the internal details object | child's explicit display projection |
| `details.accessIntent` | gate surface, match values, boundary value | same child-fixed facts projected by the server |
| `details.command` | winning Bash command unit | absent |
| `details.message` | formatted prompt; includes full Bash input text when it differs from the winning unit | same child-formatted prompt, prefixed with child identity by the server |
| raw tool input | unavailable | unavailable |
| wire `principal` / `requesterCwd` | unavailable | deliberately withheld from chain links |
| ask-time `ExtensionContext` | unavailable | unavailable |

For a Bash ask, `details.accessIntent.matchValues[0]` and direct `details.command` identify the permission-system command unit that caused `ask`. The full original Bash input is not preserved as a structured authorizer field; when it differs, it survives only inside the formatted `details.message` text. The later input-contract decision must not pretend that `details.command` is the full raw Bash invocation or silently parse an authorization-critical command from prose.

## Registration and context-ownership hazards

The permissions service is stored under `Symbol.for(...)` on `globalThis` and registration stores an authorizer callback in the service owner's `AuthorizerRegistry`.

- A normal UI root publishes its service.
- A registered in-process child does not publish its own service, but still emits the ready event.
- Consequently, a consumer extension loaded in that child can resolve the parent's process-global service. If it registers, its child-captured closure is stored in the parent's registry. If the root already registered the same name, duplicate registration throws.
- A separate child process has separate `globalThis` state and may have its own service lifecycle; registering there would create a child-local link with child-captured context.

Therefore successful `getPermissionsService()` lookup does **not** prove that the current extension instance owns that service's session context.

## Safe v0.1 ownership contract

1. Register the AI Judge only from a lifecycle context proven to be the UI-present, non-subagent root. Do not register from headless or subagent lifecycle contexts.
2. Snapshot and retain that root context/session identity as registration provenance. The callback must not infer ownership merely from the process-global service lookup.
3. For `details.forwarding` absent, treat the captured root conversation as the requester's current conversation.
4. For `details.forwarding` present, label the origin as forwarded and treat the captured conversation only as **serving-root user-intent context**. Never describe it as the child's conversation and never infer child-local dialogue that is not present.
5. Preserve `details.forwarding.requesterSessionId` and `requesterAgentName` as provenance. If forwarded provenance is missing, blank, or `unknown`, the Judge must return `{ kind: "defer" }`.
6. If registration provenance is not demonstrably the UI root, the captured session changed unexpectedly, or context ownership otherwise cannot be established, return `{ kind: "defer" }`.
7. Judge `defer` means continue through the authorizer chain to human or terminal authority. The Judge must not synthesize `confirmationUnavailable`; only terminal authority owns unavailable-authority denial.
8. Ensure a logical forwarded request produces at most one Judge prediction. Root-only registration is the v0.1 mechanism that avoids child-then-parent duplicate judgments.

Whether serving-root conversation is sufficient evidence to grant a later Enforce-mode `allow` for a forwarded child request remains a product decision for **Define the exact authorization input and conversation contract**. The facts established here are that root user intent is available, child conversation is not, and the two must not be conflated.

## Implications for the later input-contract ticket

- Add an explicit origin such as `local` or `forwarded_subagent`.
- Record the conversation owner separately from requester identity.
- For forwarded asks, carry only the link-visible projection: `details.forwarding`, `details.surface/value`, `details.accessIntent`, and the formatted message. Do not claim access to the raw `ForwardedPermissionRequest`, `principal`, or `requesterCwd`.
- Define structured handling for both the triggering Bash command unit and the unavailable full raw Bash invocation. If v0.1 requires the full invocation as structured data, permission-system must expose it; prose parsing is not an equivalent contract.
- Keep the user-intent priority explicit: root user messages are authoritative; child agent identity and the command are evidence, not instructions.

## Evidence index

| Claim | Primary source |
|---|---|
| Link callback receives only `details`, `query`, and `log` | `@gotgenes/pi-permission-system/src/authority/authorizer.ts`, `Authorizer.authorize` |
| Links compose before each session's terminal | `src/authority/authorizer-selection.ts`, `AuthorizerSelection.escalate`; `src/authority/authorizer-chain.ts`, `composeAuthorizerChain` |
| `defer` continues; `deny` is decisive | `src/authority/authorizer-chain.ts`, `decideFromVerdict` |
| Child terminal writes and polls forwarded request | `src/authority/approval-escalator.ts`, `ParentAuthorizer.waitForForwardedApproval` and `pollForForwardedResponse` |
| Root policy resolves before root escalation | `src/authority/forwarded-request-server.ts`, `resolveDecision` |
| Forwarded details projection and disclosure boundary | `src/authority/forwarded-request-server.ts`, `buildForwardedAskDetails` and `toAccessFacts` |
| Link-visible details fields | `src/authority/permission-prompter.ts`, `PromptPermissionDetails` |
| Full Bash command appears only in formatted message when distinct | `src/permission-prompts.ts`, `formatAskPrompt`; `src/handlers/gates/tool.ts`, `describeToolGate` |
| UI display derives from winning `details.command` | `src/permission-ui-prompt.ts`, `buildUiPrompt` and `directValue` |
| Service is process-global | `src/service.ts`, `SERVICE_KEY`, `publishPermissionsService`, `getPermissionsService` |
| Registered in-process child skips publication but emits ready | `src/service-lifecycle.ts`, `PermissionServiceLifecycle.activate` |
| Duplicate authorizer names throw | `src/authority/authorizer-registry.ts`, `AuthorizerRegistry.register` |
| Only UI non-subagent sessions poll forwarded inboxes | `src/authority/forwarding-manager.ts`, `ForwardingManager.start` |
| Registry-first, environment-second target resolution | `src/authority/permission-forwarding.ts`, `resolvePermissionForwardingTargetSessionId` |
| Multi-hop mismatch warns but continues | `src/authority/forwarded-request-server.ts`, `warnOnMultiHop` |
| Current Judge captures no context | `packages/pi-permission-ai-judge/src/index.ts`, current `session_start` handler and registered callback |

## Residual verification gap

The source establishes the registration hazard, but no runtime probe was run to observe extension lifecycle ordering when the future AI Judge is loaded into a registered in-process child. Before implementation acceptance, run one focused probe that logs, without conversation content:

- registering extension session ID and `hasUI`;
- service-owning session ID if exposed;
- callback invocation origin (`local`/`forwarded`);
- forwarded requester session ID.

The probe should confirm that the root-only guard prevents child registration and that one forwarded Bash ask creates exactly one Judge prediction at the serving root.
