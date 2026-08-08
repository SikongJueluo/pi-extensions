# Permission Authorization

This context describes how ambiguous coding-agent operations are reviewed before they may execute.

## Language

**Deterministic Permission Policy**:
The rule-based authority that classifies an operation as allowed, denied, or requiring a decision.
_Avoid_: Static judge

**Authorization Judge**:
An independent reviewer that proposes a verdict for an operation the Deterministic Permission Policy could not decide.
_Avoid_: Bash parser, safety classifier

**Shadow Mode**:
An observation mode in which an Authorization Judge records a verdict without changing whether the operation executes.
_Avoid_: Dry run

**Enforce Mode**:
An authority mode in which an Authorization Judge's allow verdict may approve an operation. In the initial rollout, deny and defer still pass to the next authority.
_Avoid_: Production mode

**Judge Participation**:
The presence of an Authorization Judge in the configured authorizer chain. Participation determines whether the Judge is consulted, independently of whether it is in Shadow Mode or Enforce Mode.
_Avoid_: Enabled, installed

**Defer**:
A verdict stating that the available information or the judge itself is insufficient to decide, leaving the decision to the next authority.
_Avoid_: Deny, error

**False Allow**:
A Shadow Mode outcome in which the Authorization Judge proposes approval and the human reviewer rejects the same permission request.
_Avoid_: False positive

**Requesting Session**:
The session in which the operation requiring authorization originated. For a forwarded request, this is the child session.
_Avoid_: Current session

**Serving Session**:
The authority-bearing session that resolves a forwarded request and runs its configured Authorization Judge before the terminal human authority.
_Avoid_: Parent context, current session

**Conversation Owner**:
The session whose conversation entries are supplied to an Authorization Judge. It may differ from the Requesting Session for forwarded requests.
_Avoid_: Requester
