---
status: accepted
---

# Enforce audit self-sufficiency — no upstream host contract

PIEXTENSIO-10 (promotion governance) and PIEXTENSIO-13/15 (host contract
and enforce gates) conditioned the allow-only Enforce authority on a
formal **host contract** in upstream `@gotgenes/pi-permission-system`:
acknowledged review writes, capability versioning, pre-link enrollment,
and a LocalUserAuthorizer-only human-decision marker. We decided to drop
that dependency: every guarantee Enforce needs will be **provided by the
Judge package itself**, and the upstream stays untouched at zero changes.

## Why the original design was wrong

Not "too early" — structurally wrong. Every contract item is complexity
the upstream maintainer must carry **forever**, serving a plugin he does
not use. His own users gain nothing from it. A PR of that shape sits in
the queue forever (observed: upstream has unprocessed PRs already).
Designing our audit needs as host obligations is asking someone else to
pay for our feature.

The "self-recording is untrustworthy" argument also failed scrutiny under
the actual threat model: this Judge runs on the operator's own machine,
single-user. The Judge can be *buggy* but has no motive to *deceive*.
Bugs are covered by in-process self-checks; "independent third-party
audit" is an enterprise-multi-tenant requirement we do not have.
(The original patches were also lost with `~/Projects/.workspace/`
cleanup and were never pushed — the dependency was not just unwanted but
gone.)

## What self-sufficiency means concretely

1. **Judge-owned audit log**, separate file from the permission-system
   review log (which also solves an operational pain: that log is ~850KB
   of mixed events). Append + fsync per record; a failed write marks the
   runtime **unhealthy**, and the Enforce truth table's telemetry gate
   refuses authority while unhealthy. This is the self-implemented
   version of "acknowledged writes".
2. **Human-decision attribution at the consumption side.** Real-human
   decisions are distinguishable by event shape
   (`approved`/`denied` from the dialog vs `session_approved`/
   `auto_approved`/`infrastructure_auto_allowed`), verified against live
   data in the 2026-08-17 TUI cohort (round 5 showed forwarded
   `auto_approved` double-writes). The analyzer filters cohort rows on
   this shape instead of the upstream marking humans.
3. **Denominator redefined** as "asks the Judge itself received"
   (waiting rows in the Judge log), not upstream pre-link enrollment.
   Self-consistent bookkeeping; the PIEXTENSIO-10 floor math applies to
   this denominator unchanged.
4. The truth-table gate `hostContractPresent` becomes a **local
   self-check gate** (audit log healthy). Mechanically identical in
   effect: today's production state already defers unconditionally.

## What is explicitly not weakened

- The PIEXTENSIO-10 floor (100 qualified rows, zero false allows,
  per-segment) stands, computed on the self-owned log.
- Allow-only semantics stand: the Judge never denies; every uncertain
  case defers to the human dialog.
- Fail-closed stands: audit unhealthy → defer; malformed evidence →
  defer; unknown state → defer.

## Consequences

- PIEXTENSIO-15 is cancelled (single-consumer upstream feature =
  unmaintainable dependency). Its lessons stay here.
- If the upstream ever ships an equivalent contract on its own
  initiative, the Judge may adopt it later; nothing in this design
  blocks that. Revisit trigger: multi-user / multi-tenant deployments
  where the "buggy-but-honest" threat model no longer holds.
- Promotion cohort identity is unaffected (model/prompt/evidence
  profile); the audit-log switch is a governance-consumer change.
