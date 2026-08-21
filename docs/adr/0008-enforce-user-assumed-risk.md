---
status: accepted
---

# Enforce as user-assumed risk — promotion gates leave the runtime

PIEXTENSIO-23. This ADR supersedes the **runtime effect** of the
per-segment promotion floor (PIEXTENSIO-10, as consumed by PIEXTENSIO-21)
while keeping every historical artifact immutable. Enforce stops being a
"model earned safety certification" mode and becomes what it actually is:
a convenience mode where the user explicitly assumes the risk of model
misjudgment to reduce manual review.

## What changes

1. **The three promotion record gates (`cohort_qualified`,
   `owner_approval`, `activation`) are no longer Enforce authority
   inputs.** The truth table keeps its fail-closed health gates — audit
   health, telemetry, result kind, review acknowledgement,
   generation-current — but a session with no promotion records can now
   hold Enforce authority.
2. **Risk contract replaces certification.** Writing `mode: "enforce"`
   in config v2 *is* the consent: the user authorizes the selected judge
   model to approve ordinary operations on their behalf and accepts
   missed/wrong judgments. The project makes no "model safety
   certification" claim and does not attempt to cover all dangerous shell
   behavior. AI `allow` can auto-run; AI `deny`/`defer` still fall back
   to the human dialog (no auto-deny authority is introduced).
3. **Narrow built-in high-risk override (code-level, not a sandbox).**
   A small deterministic classifier recognizes clear-cut command shapes in
   four categories — data loss / history rewrite (ADR 0007's enumerated
   shapes), publish/deploy/infrastructure destruction, privilege
   escalation / system modification, and direct credential
   read/output/delete/replace. In Shadow it still calls the model
   (quality observation stays) and records the override; in Enforce it
   skips the model and defers immediately with an explicit risk code.
   It matches only well-known explicit shapes — no alias resolution,
   script-content analysis, variable expansion, or "every opaque command
   defers" rule. There is deliberately **no `alwaysPrompt` user
   config**: that was rejected as re-inventing policy text-matching; if a
   "this permission rule always forces a human" need ever emerges, it
   belongs in the permission-system's own `force_prompt` /
   delegation-exclusion semantics, not in the Judge.
4. **Config v2 with explicit migration.** `version: 2` adds
   `model: {provider, id}` — a fixed judge model, resolved per ask; if it
   cannot be resolved (unknown model, unauthenticated, unsupported API)
   the ask defers with a visible infrastructure code, never silently
   falling back to the session model. Unset `model` keeps following the
   session model (legacy behavior). Legacy v1 `mode: "enforce"` meant
   "exact identity certified" under the old governance; upgrading must
   not silently widen that consent, so a config without `version: 2`
   that sets `enforce` falls back to Shadow with a diagnostic requiring
   one explicit migration.
5. **One session-start notification** in Enforce mode shows the actual
   judge model and the risk contract; it does not repeat per ask.

## What is explicitly preserved

- **Historical evidence immutability.** `promotion-records.jsonl`, the
  cohort declarations/reports under `docs/testing/`, and every archived
  analyzer artifact stay byte-for-byte as they are. The runtime stops
  *consuming* them; nobody deletes or rewrites them. The failed cohorts
  are not reopened.
- **ADR 0006 self-sufficiency stands.** The Judge-owned audit log, its
  sticky health gate, and the fail-closed truth-table discipline are
  unchanged; only the three promotion inputs leave the table.
- **ADR 0007's boundary is unchanged in substance** — irreversible
  operations always defer. v4 keeps it at the prompt level; this ADR
  adds a deterministic preflight backstop for the enumerated shapes
  (exactly the fallback 0007 anticipated: "deterministic preflight defer
  for the enumerated irreversible shapes").

## Why

The certification framing asked a personal convenience tool to carry an
enterprise-grade evidentiary apparatus, and the apparatus could not even
carry itself: v4 exposed a protocol contradiction — the declaration froze
`earliest report asOf 22:05Z` while the report's actual `asOf` is
`21:15:06Z`, the PASS outcome was recorded at `21:20Z` (before the frozen
earliest report), and the `-04` declaration incorporates `-02`'s frozen
sections "by reference" although the current file no longer contains them.
These are recorded here as **legacy-mechanism limitations**, not rewritten
away. The honest conclusion is that the runtime gate derived no real
safety from a process this fragile, while the user-visible value of
Enforce (fewer dialogs on ordinary commands) never needed it. What
actually needs to stay certain — irreversible shapes reach a human,
auditability, fail-closed behavior on infra failures — is kept by the
narrow override and the retained health gates.

## Consequences

- `promotion.ts`, its tests, and `tools/promotion-record.ts` are deleted;
  disk records survive. Future model-quality evidence (advisory catalog,
  replay runs) informs *recommendations* and documentation only, never
  runtime authority — milestone 2 of PIEXTENSIO-23.
- Rollback is `mode: "shadow"`.
- Revisit trigger: multi-user / delegated deployments where "the config
  author is the risk bearer" stops being true.
