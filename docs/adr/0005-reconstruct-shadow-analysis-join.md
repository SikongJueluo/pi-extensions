---
status: accepted
---

# Reconstruct the Shadow comparison join from existing permission events

PIEXTENSIO-9 defines the v0.1 evaluation contract: for each enrolled
permission request, correlate the Judge's prediction with the later human
decision, offline, by `requestId`. Its required event stream is
`authorizer_link.invoked` (enrollment), `ai_bash_judge.result` (prediction),
and `permission_request.human_decided` (blind reference). None of these
events exist verbatim in `@gotgenes/pi-permission-system` 25.3/25.4, and the
tickets acknowledge this: until the upstream gaps close, collected records
are **diagnostic Shadow evidence only**, never promotion-grade.

We decided the offline analyzer reconstructs the contract from the events
that *do* exist, rather than waiting for upstream changes (or patching the
dependency).

## Reconstruction rules

| Contract event | Reconstructed from | Why it holds |
| --- | --- | --- |
| Enrollment | `authorizer_chain_resolved` whose `links` array contains `ai-bash-judge` | Upstream records resolved links **before any link runs** — its own doc comment cites exactly the "judge never ran vs. ran and deferred" distinction. Appending after `authorizer_link.invoked` semantics. |
| Prediction | `ai_bash_judge.result` | Judge-owned; already keyed by `requestId`. |
| Human decision | `permission_request.approved`/`.denied` **with attribution** | `approved_for_session`/`approved_for_serving_session` can only originate from the human (upstream `decideFromVerdict` grants links only the one-shot `approved` state). A plain `approved`/`denied` is attributed to the human **unless** the same `requestId` carries a decisive link marker (`inner_cmd.allow`/`inner_cmd.deny`, made joinable in this repo). |

`permission_request.session_approved` and
`permission_request.infrastructure_auto_allowed` are not enrollments: the
chain never runs for rule-satisfied or session-remembered asks, so they are
correctly outside the denominator.

Rows where attribution fails (a plain `approved` sharing the request with a
link allow — the one case the marker rule cannot decide) stay joined but are
marked `unproven` and never enter the comparison matrix. Duplicate results,
result-before-enrollment ordering violations, multiple human decisions, and
unreadable terminal states are quarantined by category, never dropped.

## Alternatives rejected

- **Upstream PR now**: the three events plus a write-acknowledgement seam
  are structurally required *for promotion*, but upstream merge latency and
  release cadence would stall cohort collection. The reconstruction gives
  the calibration data that a future PR needs as justification.
- **Local patch of the dependency**: maintains a fork against a moving
  25.x; the global installation loads released versions.

## Consequences

- The analyzer reads upstream implementation details (event names, state
  vocabulary, link-state semantics), not a contract. An upstream refactor
  can silently break the reconstruction; the quarantine categories and
  coverage metrics are the designed tripwire — a spike in
  `terminal_event_unreadable` or a coverage collapse indicates drift, not
  data.
- `¬marker ⇒ human` is an inference. PIEXTENSIO-9 forbids analyzers from
  inferring outcomes; diagnostic reports therefore carry an explicit
  `DIAGNOSTIC (reconstructed join; not promotion-grade)` header, and the
  promotion floor (PIEXTENSIO-10) cannot be satisfied from reconstructed
  rows at all.
- Write-acknowledgement is likewise reconstructed only negatively: a
  disabled review sink is detected from the config file, but an
  in-flight write failure surfaces only as a missing result (a coverage
  gap), not a positive fault signal.
