import { describe, expect, it } from "vitest";
import {
    evaluateEnforceAuthority,
    type EnforceGateState,
} from "../src/judge";
import {
    loadPromotionRecords,
    resolvePromotionGates,
    type CandidateIdentity,
} from "../src/promotion";

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

describe("evaluateEnforceAuthority — production state with no promotion records", () => {
    // The real post-PIEXTENSIO-21 seam: an empty records file (the normal
    // pre-promotion state) closes all promotion gates, so every mode and
    // telemetry state defers — mechanically identical to v0.1's hardcoded
    // closure, now derived from actual storage.
    const emptySnapshot = loadPromotionRecords({
        agentDir: "/nonexistent-agent-dir",
    });
    const identity: CandidateIdentity = {
        judge: "@sikongjueluo/pi-permission-ai-judge@0.0.1",
        permissionSystem: "25.4.0",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        api: "openai-codex-responses",
        promptVersion: "bash-shadow-v4",
        toolSchemaVersion: "report-verdict-v1",
        reviewSchemaVersion: "1",
        timeoutCohort: 30000,
    };

    it("never grants authority for any mode or telemetry state without records", () => {
        const modes = ["shadow", "enforce"] as const;
        const healths = ["healthy", "disabled", "write_failed", "integrity_anomaly"] as const;
        for (const mode of modes) {
            for (const health of healths) {
                const gates = resolvePromotionGates(emptySnapshot, identity);
                const outcome = evaluateEnforceAuthority({
                    ...ALL_OPEN,
                    mode,
                    telemetryHealth: health,
                    ...gates,
                });
                expect(outcome.kind).toBe("defer");
            }
        }
    });

    it("blocks enforce on the cohort gate first even with healthy audit", () => {
        const gates = resolvePromotionGates(emptySnapshot, identity);
        const outcome = evaluateEnforceAuthority({
            ...ALL_OPEN,
            ...gates,
        });
        expect(outcome).toEqual({
            kind: "defer",
            blockedBy: "cohort_not_qualified",
        });
    });

    it("grants authority only when every record kind exists for the exact identity", () => {
        const records = [
            {
                kind: "cohort_qualified",
                candidateIdentity: identity,
                recordedAt: "2026-08-20T12:00:00Z",
                basis: "cohort test",
            },
            {
                kind: "owner_approval",
                candidateIdentity: identity,
                recordedAt: "2026-08-20T12:01:00Z",
                basis: "approved",
            },
            {
                kind: "activation",
                candidateIdentity: identity,
                recordedAt: "2026-08-20T12:02:00Z",
                basis: "activated",
            },
        ] as const;
        const snapshot = {
            records,
            healthy: true,
            diagnostic: null,
            path: "unused",
        };
        const gates = resolvePromotionGates(snapshot, identity);
        expect(evaluateEnforceAuthority({ ...ALL_OPEN, ...gates })).toEqual({
            kind: "allow",
        });
    });
});
