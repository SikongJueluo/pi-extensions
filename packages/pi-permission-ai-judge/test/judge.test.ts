import { describe, expect, it } from "vitest";
import {
    evaluateEnforceAuthority,
    v01ProductionGateState,
    type EnforceGateState,
} from "../src/judge";

const ALL_OPEN: EnforceGateState = {
    auditHealthy: true,
    telemetryHealth: "healthy",
    cohortQualified: true,
    ownerApprovalRecorded: true,
    activationRecorded: true,
    resultKind: "judgment",
    verdict: "allow",
    reviewAcknowledged: true,
    generationCurrent: true,
    mode: "enforce",
};

describe("evaluateEnforceAuthority — every gate independently forces defer", () => {
    it("allows only when every gate holds", () => {
        expect(evaluateEnforceAuthority(ALL_OPEN)).toEqual({ kind: "allow" });
    });

    const cases: ReadonlyArray<{
        name: string;
        patch: Partial<EnforceGateState>;
        expectedReason: string;
    }> = [
        { name: "shadow mode", patch: { mode: "shadow" }, expectedReason: "mode_shadow" },
        { name: "audit log unhealthy", patch: { auditHealthy: false }, expectedReason: "audit_unhealthy" },
        { name: "telemetry disabled", patch: { telemetryHealth: "disabled" }, expectedReason: "telemetry_disabled" },
        { name: "telemetry write failed", patch: { telemetryHealth: "write_failed" }, expectedReason: "telemetry_write_failed" },
        { name: "telemetry integrity anomaly", patch: { telemetryHealth: "integrity_anomaly" }, expectedReason: "telemetry_integrity_anomaly" },
        { name: "cohort not qualified", patch: { cohortQualified: false }, expectedReason: "cohort_not_qualified" },
        { name: "owner approval absent", patch: { ownerApprovalRecorded: false }, expectedReason: "owner_approval_absent" },
        { name: "activation absent", patch: { activationRecorded: false }, expectedReason: "activation_absent" },
        { name: "preflight result", patch: { resultKind: "preflight_defer" }, expectedReason: "result_preflight_defer" },
        { name: "infrastructure result", patch: { resultKind: "infrastructure_failure" }, expectedReason: "result_infrastructure_failure" },
        { name: "semantic deny verdict", patch: { verdict: "deny" }, expectedReason: "verdict_deny" },
        { name: "semantic defer verdict", patch: { verdict: "defer" }, expectedReason: "verdict_defer" },
        { name: "review unacknowledged", patch: { reviewAcknowledged: false }, expectedReason: "review_unacknowledged" },
        { name: "stale generation", patch: { generationCurrent: false }, expectedReason: "generation_stale" },
    ];

    for (const { name, patch, expectedReason } of cases) {
        it(`${name} defers with a distinct reason`, () => {
            const state: EnforceGateState = { ...ALL_OPEN, ...patch };
            expect(evaluateEnforceAuthority(state)).toEqual({
                kind: "defer",
                blockedBy: expectedReason,
            });
        });
    }
});

describe("evaluateEnforceAuthority — v0.1 production state", () => {
    it("never grants authority for any mode or telemetry state in v0.1", () => {
        const modes = ["shadow", "enforce"] as const;
        const healths = ["healthy", "disabled", "write_failed", "integrity_anomaly"] as const;
        for (const mode of modes) {
            for (const health of healths) {
                const outcome = evaluateEnforceAuthority(
                    v01ProductionGateState(mode, health),
                );
                expect(outcome.kind).toBe("defer");
            }
        }
    });

    it("blocks v0.1 enforce on the cohort gate even with healthy audit", () => {
        const outcome = evaluateEnforceAuthority(
            v01ProductionGateState("enforce", "healthy", true),
        );
        expect(outcome).toEqual({ kind: "defer", blockedBy: "cohort_not_qualified" });
    });

    it("blocks v0.1 enforce on the audit gate when the audit log is unhealthy", () => {
        const outcome = evaluateEnforceAuthority(
            v01ProductionGateState("enforce", "healthy", false),
        );
        expect(outcome).toEqual({ kind: "defer", blockedBy: "audit_unhealthy" });
    });
});
