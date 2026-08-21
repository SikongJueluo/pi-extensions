import type { TelemetryHealth } from "../telemetry/review";

/**
 * Enforce truth table (PIEXTENSIO-3 cat.4 / M5; ADR 0008 / PIEXTENSIO-23).
 *
 * `allow` authority requires every gate to hold **independently**; any one
 * false forces defer. Since ADR 0008 the promotion gates (cohort
 * qualification, owner approval, activation) are no longer authority
 * inputs: hand-written `mode: "enforce"` in config v2 is the user's risk
 * consent, and the remaining gates are the fail-closed runtime health
 * checks — verified by the truth-table tests toggling each condition.
 */

export type EnforceGateState = {
    /** The Judge-owned audit log is healthy (ADR 0006 self-check gate). */
    readonly auditHealthy: boolean;
    /** Runtime telemetry healthy at decision time. */
    readonly telemetryHealth: TelemetryHealth;
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
 * `blockedBy` reasons keep each gate's veto observable in tests and in the
 * authority field of every result row without granting anything.
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
