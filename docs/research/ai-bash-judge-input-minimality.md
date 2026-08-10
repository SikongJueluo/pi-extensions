# Research: minimal evidence for the AI Bash authorization judge v0.1

## Question

Does the proposed six-cluster `JudgeRequestV1` contract contain fields that do not help the model decide whether to allow a Bash authorization request?

The proposal grouped:

- `version` and `origin`;
- authorization `requestId`, `surface`, and `accessIntent`;
- command `triggeringUnit` and `fullInput`;
- requester `sessionId` and `agentName`;
- conversation `ownerSessionId`, `source`, and `items`;
- execution `cwd`.

This report distinguishes:

1. evidence that can change the model's verdict;
2. adapter data needed to obtain or validate that evidence;
3. correlation, transport, and evaluation metadata that belongs outside the model prompt.

Planning only: this report does not specify implementation types or implement the Judge.

## Conclusion

The concern is valid. The proposal mixed three different responsibilities into one product-level request object and was therefore over-designed.

The model needs a small evidence packet:

1. the complete original Bash input;
2. the particular command unit that triggered the permission ask, when it differs from the complete input;
3. the actual execution working directory when it affects relative-path meaning;
4. the allowed conversation text that establishes user intent;
5. for a forwarded ask only, enough provenance to explain that the command came from a named child while the supplied conversation belongs to the serving root.

UUIDs, schema versions, the constant Bash surface, session ownership IDs, retrieval-source tags, mode, model metadata, and log correlation fields do not improve the model's authorization judgment. Some remain necessary for validation, testing, or logs, but they should not be presented as model evidence.

The ticket should therefore define an **evidence contract**, not prescribe a broad transport-shaped `JudgeRequestV1`.

## Source facts

### The current Authorizer seam is transport-shaped

An external link receives:

```ts
authorize(
  details: PromptPermissionDetails,
  query: PermissionQuery,
  log: AuthorizerLog,
): Promise<AuthorizerVerdict>
```

`PromptPermissionDetails` includes display, correlation, provenance, and gate facts together. It is the permission-system callback contract; it is not evidence that every field should be copied into a model prompt.

Sources:

- `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/authority/authorizer.ts`, `Authorizer.authorize`
- `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/authority/permission-prompter.ts`, `PromptPermissionDetails`

### The full Bash input is currently missing as a structured Authorizer field

`describeToolGate()` still has the original tool input. `formatAskPrompt()` reads `input.command`, but when it differs from the winning command unit it embeds the full input only in formatted prose. The structured `details.command` remains the command unit selected by the permission check.

Consequences:

- `details.command` must not be mislabeled as the complete Bash input;
- authorization-critical text must not be reconstructed by parsing `details.message`;
- v0.1 requires the permission system to expose the original Bash input structurally;
- before that dependency exists, Shadow may provide the entire formatted message as explicitly labeled legacy evidence, but it must not claim to have recovered `fullInput`;
- Enforce must defer whenever an allow would depend on missing structured full input.

Sources:

- `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/handlers/gates/tool.ts`, `describeToolGate`
- `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/permission-prompts.ts`, `formatAskPrompt`
- `docs/research/ai-bash-context-ownership.md`, “What an authorizer link can actually see”

### The true forwarded execution cwd exists on the wire but is hidden from links

The child stamps `requesterCwd` while constructing its forwarded access intent. The serving node's `toAccessFacts()` deliberately omits it from `PromptPermissionDetails`. Substituting the serving root's cwd would change the meaning of relative paths.

Therefore v0.1 also requires the permission system to expose the true requesting-session cwd to the Judge. If it remains unavailable and cwd affects the command's meaning, Enforce must defer.

Sources:

- `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/authority/approval-escalator.ts`, construction of forwarded `accessIntent`
- `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/authority/forwarded-request-server.ts`, `toAccessFacts`
- `CONTEXT.md`, **Execution Working Directory**

### Conversation ownership is a retrieval rule, not model evidence by itself

The Authorizer callback has no ask-time `ExtensionContext`. The Judge must use the root lifecycle context captured when it registers. For a direct ask, that conversation belongs to the requester. For a forwarded ask, it is only the serving root's user-intent context; the child transcript is unavailable.

The model needs the allowed conversation text and a truthful label for forwarded provenance. It does not benefit from session UUIDs or the literal retrieval implementation name `active_compacted_branch`.

Sources:

- `docs/research/ai-bash-context-ownership.md`, “Safe v0.1 ownership contract”
- Pi official `docs/session-format.md`
- Pi official `docs/compaction.md`
- `CONTEXT.md`, **Requesting Session**, **Serving Session**, and **Conversation Owner**

### The first-party model judge separates decision evidence from logs

The narrower `pi-permission-model-judge` sends only the candidate path and task instruction to its model. It uses `requestId`, model ID, latency, matched pattern, and defer reason for the review trail instead of including them in the model prompt.

That package solves a much narrower deny-first typo problem, so it does not prove that command, cwd, or conversation are unnecessary for an allow-capable Bash Judge. It does demonstrate the correct separation between model evidence and observability metadata.

Sources:

- <https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-model-judge/src/model-review.ts>
- <https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-model-judge/src/typo-reviewer.ts>

## Field-by-field assessment

| Proposed field | Can change model verdict? | Keep where? | Reason |
|---|---:|---|---|
| `version` | No | Prompt-construction/tests/logs | PIEXTENSIO-8 requires a versioned prompt/tool schema, not a version token as model evidence. |
| `origin` | Sometimes | Derived prompt label | Relevant mainly for forwarded asks because it changes how conversation evidence must be interpreted. |
| `requestId` | No | Review log | Correlates Judge and human outcomes; a UUID conveys no authorization intent. |
| `surface` | No in this Judge | Adapter precondition | The Judge participates only for Bash; non-Bash asks defer before a model call. |
| full `accessIntent` | Generally no | Adapter validation | It is gate/transport structure. Project only the exact semantic fact the model needs, such as the triggering unit; do not expose the whole object. |
| `triggeringUnit` | Yes, conditionally | Model evidence | Identifies the exact unit under review in a compound input. It is redundant when identical to `fullInput`. |
| `fullInput` | Yes, essential | Model evidence | Pipelines, chaining, substitutions, redirections, and quoting can disappear when only one unit is shown. |
| requester `sessionId` | No | Provenance validation/logs | Needed to establish forwarded provenance, not useful to the model. |
| requester `agentName` | Sometimes | Forwarded model label | Helps interpret a delegated ask; usually redundant for a direct root ask. It is provenance, not authority. |
| `ownerSessionId` | No | Adapter ownership check | Prevents judging from the wrong session; UUID itself should not reach the model. |
| conversation `source` | No | Adapter rule/tests | “Current active branch with compaction applied” describes how evidence is obtained. |
| conversation `items` | Yes | Model evidence after filtering | User intent is what distinguishes an authorized risky operation from agent improvisation. Only the settled text whitelist is admitted. |
| execution `cwd` | Yes, conditionally essential | Model evidence | Determines the meaning of relative paths and filesystem effects. It must be the requester's cwd, not the serving root's cwd. |

## Marginal-value examples

### Compound command

```bash
npm test && git push --force origin main
```

If the deterministic gate asks on `git push --force origin main`, the triggering unit focuses the review, while the full input shows the condition under which it runs. The request ID, session IDs, and `surface: "bash"` add no decision value.

### Relative destructive operation

```bash
rm -rf ./build
```

The complete command is insufficient to determine the target. The actual execution cwd can distinguish a project build directory from an unintended location. A serving-root cwd is actively misleading for a forwarded child ask.

### Explicitly authorized risky action

```bash
git push --force-with-lease origin main
```

The command communicates risk; the allowed conversation text establishes whether the user explicitly requested the force push. Model/provider metadata and active-branch identifiers do not affect that question.

### Forwarded child ask

A child named `release-worker` requests the push after the root user asked to prepare a release. The useful provenance is:

- this is a forwarded ask;
- requester label: `release-worker`;
- supplied conversation is serving-root intent only;
- child-local reasoning is unavailable.

The child and owner session UUIDs do not help the model. If the root intent does not clearly cover the delegated operation, the settled behavior is `defer`.

## Recommended v0.1 evidence contract

The exact implementation shape is intentionally left open, but the rendered model input should contain only these semantics:

```text
Authorization target
- complete Bash input: required structured text
- triggering unit: present only when it differs from the complete input
- execution working directory: true requesting-session cwd when relevant

User-intent evidence
- filtered text from the serving session's current active, compacted branch
- compaction summaries explicitly labeled derived and untrusted

Forwarded provenance (only when forwarded)
- requester agent name, if known
- explicit notice that this is a child request
- explicit notice that the conversation is serving-root context, not child context
```

The adapter may still retain non-prompt state for safe construction:

- root registration and conversation-ownership proof;
- structured-field availability and validation;
- Bash-surface gating;
- prompt/schema version;
- truncation bookkeeping.

The review trail may retain bounded, non-conversation metadata:

- request ID;
- model and provider;
- latency/token use;
- prompt/schema version;
- verdict and stable failure/defer code;
- later human outcome for Shadow correlation.

It must not copy full conversation content into review logs.

## Resulting design correction

Do not require a broad public `JudgeRequestV1` merely to mirror permission-system fields. Define the semantic evidence and its fail-safe availability rules. During implementation, a small private type may still be useful for deterministic prompt construction and tests, but that is an implementation choice rather than part of the product contract.

This preserves the useful parts of the earlier proposal while removing fields that cannot help the model decide.
