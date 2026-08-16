import { describe, expect, it } from "vitest";
import {
    analyzeShadowReviewLog,
    type ReviewEvent,
} from "../../src/analyzer/analyze";

/** Build a minimal enrolled request lifecycle in append order. */
function lifecycle(args: {
    requestId?: string;
    verdict?: "allow" | "deny" | "defer";
    resultKind?: "judgment" | "preflight_defer" | "infrastructure_failure";
    code?: string | null;
    resolution?: string;
    linkMarker?: boolean;
}): ReviewEvent[] {
    const requestId = args.requestId ?? "req-1";
    const events: ReviewEvent[] = [
        {
            event: "authorizer_chain_resolved",
            requestId,
            links: ["ai-bash-judge", "inner-cmd"],
        },
    ];
    if (args.linkMarker) {
        events.push({ event: "inner_cmd.allow", requestId });
    }
    events.push({
        event: "permission_request.waiting",
        requestId,
    });
    events.push({
        event: "ai_bash_judge.result",
        requestId,
        resultKind: args.resultKind ?? "judgment",
        verdict: (args.resultKind ?? "judgment") === "judgment" ? (args.verdict ?? "allow") : null,
        code: args.code ?? null,
        modelCalled: (args.resultKind ?? "judgment") === "judgment",
        judgeLatencyMs: 100,
        modelLatencyMs: 90,
    });
    events.push({
        event: "permission_request.approved",
        requestId,
        resolution: args.resolution ?? "approved",
    });
    return events;
}

describe("analyzeShadowReviewLog — happy path", () => {
    it("joins a full lifecycle into one row with matrix entry allow|allow", () => {
        const { enrollments, dispositions, metrics } = analyzeShadowReviewLog(
            lifecycle({ verdict: "allow", resolution: "approved" }),
        );
        expect(enrollments).toBe(1);
        expect(dispositions).toHaveLength(1);
        expect(dispositions[0]?.kind).toBe("joined");
        expect(metrics.joined).toBe(1);
        expect(metrics.matrix).toEqual({ "allow|allow": 1 });
        expect(metrics.falseAllowRate).toBe(0);
        expect(metrics.judgeLatency).toMatchObject({ p50: 100, max: 100 });
    });

    it("counts a false allow as verdict allow + human deny", () => {
        const { metrics } = analyzeShadowReviewLog(
            lifecycle({ verdict: "allow", resolution: "denied" }),
        );
        expect(metrics.matrix).toEqual({ "allow|deny": 1 });
        expect(metrics.falseAllows).toBe(1);
        expect(metrics.falseAllowRate).toBe(1);
    });

    it("reports conservative deny and defer separately", () => {
        const deny = analyzeShadowReviewLog(
            lifecycle({ requestId: "a", verdict: "deny", resolution: "approved" }),
        );
        const defer = analyzeShadowReviewLog(
            lifecycle({ requestId: "b", verdict: "defer", resolution: "approved" }),
        );
        expect(deny.metrics.conservativeDeny).toBe(1);
        expect(deny.metrics.conservativeDefer).toBe(0);
        expect(defer.metrics.conservativeDeny).toBe(0);
        expect(defer.metrics.conservativeDefer).toBe(1);
    });

    it("normalizes session approvals to human allow", () => {
        const { metrics } = analyzeShadowReviewLog(
            lifecycle({ verdict: "defer", resolution: "approved_for_session" }),
        );
        expect(metrics.matrix).toEqual({ "defer|allow": 1 });
    });

    it("keeps preflight defers out of the matrix but in coverage", () => {
        const { metrics } = analyzeShadowReviewLog(
            lifecycle({
                resultKind: "preflight_defer",
                code: "missing_structured_input",
                resolution: "approved",
            }),
        );
        expect(metrics.matrix).toEqual({});
        expect(metrics.joined).toBe(1);
        expect(metrics.judgmentCoverage).toBe(0);
    });

    it("buckets infrastructure failures by stable code", () => {
        const { metrics } = analyzeShadowReviewLog(
            lifecycle({
                resultKind: "infrastructure_failure",
                code: "aborted",
                resolution: "approved",
            }),
        );
        expect(metrics.infrastructureFailures).toBe(1);
        expect(metrics.infrastructureByCode).toEqual({ aborted: 1 });
        expect(metrics.matrix).toEqual({});
    });
});

describe("analyzeShadowReviewLog — attribution", () => {
    it("attributes a plain approved with no link marker to the human", () => {
        const { dispositions } = analyzeShadowReviewLog(
            lifecycle({ resolution: "approved" }),
        );
        const row = dispositions[0];
        expect(row?.kind).toBe("joined");
        if (row?.kind === "joined") {
            expect(row.row.humanAttribution).toBe("no_link_marker");
        }
    });

    it("marks a plain approved sharing the request with inner_cmd.allow as unproven", () => {
        const { dispositions, metrics } = analyzeShadowReviewLog(
            lifecycle({ resolution: "approved", linkMarker: true }),
        );
        const row = dispositions[0];
        expect(row?.kind).toBe("joined");
        if (row?.kind === "joined") {
            expect(row.row.humanAttribution).toBe("unproven");
        }
        // Unproven rows stay joined but never enter the matrix.
        expect(metrics.matrix).toEqual({});
    });

    it("always attributes session-state approvals to the human despite a marker", () => {
        const { dispositions } = analyzeShadowReviewLog(
            lifecycle({
                resolution: "approved_for_session",
                linkMarker: true,
            }),
        );
        const row = dispositions[0];
        expect(row?.kind).toBe("joined");
        if (row?.kind === "joined") {
            expect(row.row.humanAttribution).toBe("session_state");
        }
    });
});

describe("analyzeShadowReviewLog — integrity", () => {
    it("quarantines a duplicate judge result", () => {
        const base = lifecycle({ verdict: "allow" });
        const dup = base.map((e) => e).concat([
            {
                event: "ai_bash_judge.result",
                requestId: "req-1",
                resultKind: "judgment",
                verdict: "deny",
            },
        ]);
        const { metrics } = analyzeShadowReviewLog(dup);
        expect(metrics.quarantined).toEqual({ duplicate_result: 1 });
        expect(metrics.joined).toBe(0);
    });

    it("quarantines a human decision recorded before the judge result", () => {
        const events: ReviewEvent[] = [
            { event: "authorizer_chain_resolved", requestId: "r", links: ["ai-bash-judge"] },
            { event: "permission_request.approved", requestId: "r", resolution: "approved" },
            {
                event: "ai_bash_judge.result",
                requestId: "r",
                resultKind: "judgment",
                verdict: "allow",
            },
        ];
        const { metrics } = analyzeShadowReviewLog(events);
        expect(metrics.quarantined).toEqual({ human_before_result: 1 });
    });

    it("counts an enrollment without a result as a coverage gap, not quarantine", () => {
        const events: ReviewEvent[] = [
            { event: "authorizer_chain_resolved", requestId: "r", links: ["ai-bash-judge"] },
        ];
        const { enrollments, metrics } = analyzeShadowReviewLog(events);
        expect(enrollments).toBe(1);
        expect(metrics.joined).toBe(0);
        expect(metrics.quarantined).toEqual({});
        expect(metrics.completionCoverage).toBe(0);
    });

    it("quarantines a judge result with no enrollment when no terminal exists", () => {
        const events: ReviewEvent[] = [
            {
                event: "ai_bash_judge.result",
                requestId: "orphan",
                resultKind: "judgment",
                verdict: "allow",
            },
        ];
        const { metrics } = analyzeShadowReviewLog(events);
        expect(metrics.quarantined).toEqual({ result_without_enrollment: 1 });
    });

    it("quarantines an unreadable terminal resolution", () => {
        const events: ReviewEvent[] = [
            { event: "authorizer_chain_resolved", requestId: "r", links: ["ai-bash-judge"] },
            {
                event: "ai_bash_judge.result",
                requestId: "r",
                resultKind: "judgment",
                verdict: "allow",
            },
            { event: "permission_request.approved", requestId: "r", resolution: "confirmation_unavailable" },
        ];
        const { metrics } = analyzeShadowReviewLog(events);
        expect(metrics.quarantined).toEqual({ terminal_event_unreadable: 1 });
    });
});

describe("analyzeShadowReviewLog — latency", () => {
    it("reports missing latency as missing, not zero", () => {
        const events = lifecycle({});
        const stripped = events.map((e) =>
            e.event === "ai_bash_judge.result"
                ? { ...e, judgeLatencyMs: undefined, modelLatencyMs: undefined }
                : e,
        );
        const { metrics } = analyzeShadowReviewLog(stripped);
        expect(metrics.judgeLatency).toMatchObject({ missing: 1, p50: 0 });
    });
});
