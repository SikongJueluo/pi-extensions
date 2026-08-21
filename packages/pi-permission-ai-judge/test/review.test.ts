import { describe, expect, it } from "vitest";
import { createReviewSink, type ReviewSinkDeps } from "../src/telemetry/review";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";

function fakeLog(): AuthorizerLog & {
    reviews: Array<{ event: string; details: Record<string, unknown> }>;
    debugs: Array<{ event: string; details?: Record<string, unknown> }>;
} {
    const reviews: Array<{ event: string; details: Record<string, unknown> }> = [];
    const debugs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    return {
        reviews,
        debugs,
        review: (event, details = {}) => reviews.push({ event, details }),
        debug: (event, details) => debugs.push({ event, details }),
    };
}

describe("createReviewSink — telemetry health", () => {
    it("marks the runtime disabled when the review log toggle is off", () => {
        const log = fakeLog();
        const deps: ReviewSinkDeps = { log, reviewLogEnabled: false };
        const sink = createReviewSink(deps);
        expect(sink.health()).toBe("disabled");
    });

    it("reports healthy when the toggle is on", () => {
        const sink = createReviewSink({ log: fakeLog(), reviewLogEnabled: true });
        expect(sink.health()).toBe("healthy");
    });
});

describe("createReviewSink — privacy denylist at the sink", () => {
    it("strips keys matching forbidden patterns before delegation", () => {
        const log = fakeLog();
        const sink = createReviewSink({ log, reviewLogEnabled: true });
        sink.review("ai_bash_judge.result", {
            requestId: "req-1",
            apiToken: "leak",
            sshKey: "leak",
            secrets: "leak",
            password: "leak",
            credentials: "leak",
            outputUsage: 10,
        });
        expect(log.reviews).toEqual([
            {
                event: "ai_bash_judge.result",
                details: { requestId: "req-1", outputUsage: 10 },
            },
        ]);
    });

    it("passes metadata-only events through unchanged", () => {
        const log = fakeLog();
        const sink = createReviewSink({ log, reviewLogEnabled: true });
        sink.review("ai_bash_judge.result", {
            schemaVersion: 1,
            requestId: "req-1",
            judgeRuntimeId: "abc",
            mode: "shadow",
            resultKind: "judgment",
        });
        expect(log.reviews[0]?.details).toEqual({
            schemaVersion: 1,
            requestId: "req-1",
            judgeRuntimeId: "abc",
            mode: "shadow",
            resultKind: "judgment",
        });
    });

    it("delegates debug writes without stripping", () => {
        const log = fakeLog();
        const sink = createReviewSink({ log, reviewLogEnabled: true });
        sink.debug("ai_bash_judge.exception");
        expect(log.debugs).toEqual([{ event: "ai_bash_judge.exception" }]);
    });
});
