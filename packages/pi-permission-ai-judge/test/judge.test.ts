import { describe, expect, it } from "vitest";
import {
    evaluateEnforceAuthority,
    type EnforceGateState,
} from "../src/judge";

const ALL_OPEN: EnforceGateState = {
    auditHealthy: true,
    telemetryHealth: "healthy",
    resultKind: "judgment",
    verdict: "allow",
    reviewAcknowledged: true,
    generationCurrent: true,
    mode: "enforce",
};

describe("evaluateEnforceAuthority — every gate independently forces defer", () => {
    it("allows when every gate holds — no promotion records required", () => {
        // ADR 0008: the promotion gates (cohort qualification, owner
        // approval, activation) are no longer authority inputs; a session
        // with zero promotion records can hold Enforce authority.
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
