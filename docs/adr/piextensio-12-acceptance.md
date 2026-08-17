# PIEXTENSIO-12 v0.1 acceptance checklist

Status of the Shadow-first AI Bash Authorization Judge v0.1 against the
PIEXTENSIO-3 implementation acceptance contract (canonical resolution
984df7a2), recorded after slice 5. This file tracks what is satisfied,
what is intentionally out of scope, and the residual gaps with their
owning decision.

## Repaired baseline (I1–I4)

- I1 `@types/node` present; `pnpm -r check` exits 0 in every package. **PASS**
- I2 test matrix discovered and executed: 9 files / 85 tests (ai-judge),
  3 files / 48 tests (inner-cmd); zero failed/skipped/todo/only. **PASS**
- I3 gate runner: clean env (`env -i`, no credentials, fakes only) —
  `pnpm -r check` + `pnpm -r test` green from the working lockfile. **PASS**
- I4 version identity: workspace and global runtime both resolve
  `@gotgenes/pi-permission-system` 25.4.0. **PASS**

## Module map (PIEXTENSIO-5 seven root modules)

| Module | File | Deterministic tests | Status |
|---|---|---|---|
| index | `src/index.ts` | `test/lifecycle.test.ts` | present |
| config | `src/config.ts` | `test/config.test.ts` | present |
| evidence | `src/evidence.ts`, `src/conversation.ts` | `test/evidence.test.ts`, `test/conversation.test.ts` | present |
| prompt | `src/prompt.ts` | `test/prompt.test.ts` | present |
| model | `src/model.ts` | `test/model.test.ts` | present |
| review | `src/review.ts` | `test/review.test.ts` | present |
| judge | `src/judge.ts` | `test/judge.test.ts` | present |
| analyzer (separate governance consumer) | `src/analyzer/` | `test/analyzer/analyze.test.ts` | present |

No eighth live module was invented.

## Category-by-category

1. **Pure builders** — evidence whitelist/exclusions, 16-item/12,000-char
   caps, latest-user preservation, head truncation, compaction flagging;
   versioned prompt snapshot with authority rules and quoted untrusted
   rendering; review key set at the sink with the privacy denylist. **PASS**
2. **Mocked model** — one completion, zero retries, no prose fallback,
   stable codes across capability shapes; 256/257 output boundary; usage
   legitimacy (missing/implausible → model_error). **PASS**
3. **Lifecycle** — one root registration; headless child never registers;
   session-id mismatch defers; per-request model capture (between-request
   switch changes the next call); shutdown aborts in-flight work. **PASS**
   (partial: ready/start ordering permutations and fake-timer teardown
   assertions are not yet enumerated — see Residual gaps.)
4. **Failure path / truth table** — every gate independently forces defer
   with a distinct reason; v0.1 production state never grants authority
   for any mode × telemetry combination. **PASS**
5. **Review trail** — metadata-only events keyed by requestId; result
   written before return; leak sentinel asserts neither command text nor
   conversation text reaches review rows. **PASS** (reconstructed join —
   ADR 0005; enrollment and human-decided events are upstream gaps.)
6. **Permission-system integration** — registerAuthorizer seam consumed
   end-to-end (live smoke: rounds 1–3, forwarded preflight rows).
   **PARTIAL**: the negative v24 Enforce fixture and the two-track
   floor tests are not mechanized; live E2E evidence substitutes.
7. **Manual Shadow** — human-governed; three fixed-window replay rounds
   archived under `docs/research/rounds/` with the comparison matrix,
   false-allow denominator, and blind-deny protocol. **PASS as diagnostic**
   (promotion floor deliberately unreachable — no 100-row cohort, by
   design, until upstream seams close).

## Pinned safety contracts (M6)

| Contract | Canonical revision |
|---|---|
| PIEXTENSIO-4 prompt boundary | 3cc3af7f-ad8d-4764-be52-ebff04982a50 |
| PIEXTENSIO-5 module map | 6931027b-d191-4357-8c26-3c3bbe29cd8a |
| PIEXTENSIO-9 review trail | de571cfe-6ff2-412a-b7f5-157250014d49 |
| PIEXTENSIO-10 promotion | 0eb13dc2-bfed-42bb-82c1-e642cbf55c52 |
| PIEXTENSIO-11 budgets | c0b0028d-8321-4d8b-895e-8fecd9c36a8e |

The timeout defaults/range and reason bound in code match PIEXTENSIO-11's
normative values (15,000 ms default, 5,000–30,000 ms accepted, 240 code
points, 256 output tokens).

## Residual gaps (owned, not silently dropped)

- Upstream seams (PIEXTENSIO-9): `authorizer_link.invoked` enrollment and
  `permission_request.human_decided` do not exist in permission-system
  25.4; the analyzer reconstructs both (ADR 0005) and the truth table
  treats `reviewAcknowledged` as structurally false. Promotion remains
  mechanically impossible — the designed v0.1 posture.
- Lifecycle ordering permutations and fake-timer teardown assertions
  (PIEXTENSIO-3 cat.3 enumerations) are thinner than the contract's full
  list; current coverage exercises the load-bearing paths (registration,
  mismatch, model switch, shutdown abort).
- The negative v24 fixture (cat.6) is satisfied by construction — the
  truth table cannot grant authority against any host surface — but not
  by a dedicated CI fixture against a real v24 package.
- Live cohort identity changed with slice 4 (prompt v2 + conversation
  evidence); rounds 1–3 are diagnostic data for the v1 candidate only.
