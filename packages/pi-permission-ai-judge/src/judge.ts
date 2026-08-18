import type { TelemetryHealth } from "./review";

/**
 * Enforce truth table (PIEXTENSIO-3 cat.4 / M5).
 *
 * `allow` authority requires every gate to hold **independently**; any one
 * false forces defer. In v0.1 the promotion gates (cohort, approval,
 * activation) are structurally unreachable — no upstream seam exists to
 * record them — so a configured `enforce` mode can never grant authority:
 * mechanically fail-closed by construction, verified by the truth-table
 * tests toggling each condition.
 */

export type EnforceGateState = {
    /** The Judge-owned audit log is healthy (ADR 0006 self-check gate). */
    readonly auditHealthy: boolean;
    /** Runtime telemetry healthy at decision time. */
    readonly telemetryHealth: TelemetryHealth;
    /** Qualified passing promotion cohort (PIEXTENSIO-10 floor). */
    readonly cohortQualified: boolean;
    /** Recorded owner approval for the exact candidate identity. */
    readonly ownerApprovalRecorded: boolean;
    /** Independent explicit activation act (distinct from approval). */
    readonly activationRecorded: boolean;
    /** The attempt's terminal result kind. */
    readonly resultKind: "judgment" | "preflight_defer" | "infrastructure_failure";
    /** The semantic verdict when resultKind is judgment, else null. */
    readonly verdict: "allow" | "deny" | "defer" | null;
    /** Review write acknowledged durably before authority. */
    readonly reviewAcknowledged: boolean;
    /** The in-flight generation is still current (not fenced by shutdown). */
    readonly generationCurrent: boolean;
    /** Effective mode (only `enforce` can even consider authority). */
    readonly mode: "shadow" | "enforce";
};

export type EnforceOutcome = { kind: "allow" } | { kind: "defer"; blockedBy: string };

/**
 * Evaluate the Enforce truth table. Shadow always defers. The distinct
 * `blockedBy` reasons keep each gate's veto observable in tests (and in a
 * future review event) without granting anything.
 */
export function evaluateEnforceAuthority(
    state: EnforceGateState,
): EnforceOutcome {
    if (state.mode !== "enforce") {
        return { kind: "defer", blockedBy: "mode_shadow" };
    }
    if (!state.auditHealthy) {
        return { kind: "defer", blockedBy: "audit_unhealthy" };
    }
    if (state.telemetryHealth !== "healthy") {
        return { kind: "defer", blockedBy: `telemetry_${state.telemetryHealth}` };
    }
    if (!state.cohortQualified) {
        return { kind: "defer", blockedBy: "cohort_not_qualified" };
    }
    if (!state.ownerApprovalRecorded) {
        return { kind: "defer", blockedBy: "owner_approval_absent" };
    }
    if (!state.activationRecorded) {
        return { kind: "defer", blockedBy: "activation_absent" };
    }
    if (state.resultKind !== "judgment") {
        return { kind: "defer", blockedBy: `result_${state.resultKind}` };
    }
    if (state.verdict !== "allow") {
        return { kind: "defer", blockedBy: `verdict_${state.verdict ?? "null"}` };
    }
    if (!state.reviewAcknowledged) {
        return { kind: "defer", blockedBy: "review_unacknowledged" };
    }
    if (!state.generationCurrent) {
        return { kind: "defer", blockedBy: "generation_stale" };
    }
    return { kind: "allow" };
}

/**
 * The v0.1 production gate state: the promotion gates are structurally
 * unreachable until the owner records a qualifying cohort, approval, and
 * activation (ADR 0006: recorded Judge-side, not via a host contract),
 * so `enforce` defers here regardless of configuration. The full truth
 * table above is exercised through injected fake gate states in tests
 * only.
 */
export function v01ProductionGateState(
    mode: "shadow" | "enforce",
    telemetryHealth: TelemetryHealth,
    auditHealthy = true,
): EnforceGateState {
    return {
        auditHealthy,
        telemetryHealth,
        cohortQualified: false,
        ownerApprovalRecorded: false,
        activationRecorded: false,
        resultKind: "judgment",
        verdict: null,
        reviewAcknowledged: false,
        generationCurrent: true,
        mode,
    };
}
