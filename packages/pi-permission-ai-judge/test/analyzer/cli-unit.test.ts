import { describe, expect, it, vi } from "vitest";
import type { ReviewEvent } from "../../src/analyzer/analyze";
import { analyzeShadowReviewLog } from "../../src/analyzer/analyze";
import {
    parseArgs,
    parseTimestampOption,
    printReport,
    withinWindow,
} from "../../src/analyzer/cli";

/**
 * In-process unit tests for the analyze-shadow CLI's pure helpers:
 * argument parsing, the time-window filter, and report rendering. The
 * end-to-end contract (file IO, dual-log mode, exit codes) lives in
 * cli-args.test.ts / cli-audit.test.ts; these tests cover branch-level
 * behavior without spawning tsx subprocesses.
 */

describe("parseArgs", () => {
    it("parses the positional path with no options", () => {
        expect(parseArgs(["node", "cli.ts", "review.jsonl"])).toEqual({
            path: "review.jsonl",
            after: null,
            before: null,
            audit: null,
        });
    });

    it("parses --after, --before, and --audit together", () => {
        const r = parseArgs([
            "node",
            "cli.ts",
            "review.jsonl",
            "--after", "2026-08-18T00:00:00Z",
            "--before", "2026-08-19T00:00:00Z",
            "--audit", "audit.jsonl",
        ]);
        expect(r).toEqual({
            path: "review.jsonl",
            after: new Date("2026-08-18T00:00:00Z"),
            before: new Date("2026-08-19T00:00:00Z"),
            audit: "audit.jsonl",
        });
    });

    it("returns the usage error for --help and -h", () => {
        expect(parseArgs(["node", "cli.ts", "--help"])).toEqual({
            error: expect.stringContaining("usage: analyze-shadow") as unknown,
        });
        expect(parseArgs(["node", "cli.ts", "-h"])).toHaveProperty("error");
    });

    it.each([
        ["missing input path", [] as const],
        ["multiple input paths", ["a.jsonl", "b.jsonl"] as const],
        ["unknown option", ["a.jsonl", "--bogus"] as const],
        ["--audit without value", ["a.jsonl", "--audit"] as const],
        ["--after without value", ["a.jsonl", "--after"] as const],
        ["invalid --after timestamp", ["a.jsonl", "--after", "nope"] as const],
        ["invalid --before timestamp", ["a.jsonl", "--before", "nope"] as const],
    ])("errors on %s", (_name, argv) => {
        const r = parseArgs(["node", "cli.ts", ...argv]);
        expect("error" in r && typeof r.error === "string").toBe(true);
    });
});

describe("parseTimestampOption", () => {
    it("requires a value", () => {
        expect(parseTimestampOption("--after", undefined)).toEqual({
            error: "--after requires a value",
        });
    });

    it("rejects unparseable timestamps", () => {
        expect(parseTimestampOption("--before", "yesterday")).toEqual({
            error: "invalid --before timestamp: yesterday",
        });
    });

    it("accepts an ISO instant", () => {
        expect(parseTimestampOption("--after", "2026-08-18T00:00:00Z")).toEqual({
            date: new Date("2026-08-18T00:00:00Z"),
        });
    });
});

describe("withinWindow", () => {
    const evt = (timestamp?: string): ReviewEvent =>
        ({ event: "e", ...(timestamp === undefined ? {} : { timestamp }) }) as ReviewEvent;

    it("keeps events without a timestamp in any window", () => {
        const window = {
            after: new Date("2026-08-18T12:00:00Z"),
            before: new Date("2026-08-18T13:00:00Z"),
        };
        expect(withinWindow(evt(), window)).toBe(true);
    });

    it("keeps events inside the window and drops those outside", () => {
        const window = {
            after: new Date("2026-08-18T12:00:00Z"),
            before: new Date("2026-08-18T13:00:00Z"),
        };
        expect(withinWindow(evt("2026-08-18T12:30:00Z"), window)).toBe(true);
        expect(withinWindow(evt("2026-08-18T11:59:00Z"), window)).toBe(false);
        expect(withinWindow(evt("2026-08-18T13:01:00Z"), window)).toBe(false);
    });

    it("applies each bound independently", () => {
        expect(
            withinWindow(evt("2026-08-18T10:00:00Z"), { after: new Date("2026-08-18T09:00:00Z"), before: null }),
        ).toBe(true);
        expect(
            withinWindow(evt("2026-08-18T10:00:00Z"), { after: null, before: new Date("2026-08-18T09:00:00Z") }),
        ).toBe(false);
    });

    it("keeps events with an unparseable timestamp regardless of bounds", () => {
        const window = {
            after: new Date("2026-08-18T12:00:00Z"),
            before: null,
        };
        // Unparseable -> NaN time -> neither bound applies.
        expect(withinWindow(evt("not-a-date"), window)).toBe(true);
    });
});

describe("printReport", () => {
    function capture(fn: () => void): string {
        const chunks: string[] = [];
        const spy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation(((s: unknown) => {
                chunks.push(String(s));
                return true;
            }) as never);
        try {
            fn();
        } finally {
            spy.mockRestore();
        }
        return chunks.join("");
    }

    const parsed = {
        path: "review.jsonl",
        after: null,
        before: null,
        audit: null,
    };

    function analyze(rows: readonly ReviewEvent[]): ReturnType<
        typeof import("../../src/analyzer/analyze").analyzeShadowReviewLog
    > {
        return analyzeShadowReviewLog(rows);
    }

    const joinedEvents: ReviewEvent[] = [
        { event: "authorizer_chain_resolved", requestId: "r1", links: ["ai-bash-judge"] },
        {
            event: "ai_bash_judge.result",
            requestId: "r1",
            resultKind: "judgment",
            verdict: "allow",
            judgeLatencyMs: 5,
            modelLatencyMs: 3,
        },
        { event: "permission_request.approved", requestId: "r1", resolution: "approved" },
    ];

    it("renders header, counts, matrix, and latency lines", () => {
        const { enrollments, metrics } = analyze(joinedEvents);
        const out = capture(() => printReport(parsed, enrollments, metrics));
        expect(out).toContain("AI Bash Judge — Shadow diagnostic report");
        expect(out).toContain("grade: DIAGNOSTIC");
        expect(out).toContain("enrollments (N): 1");
        expect(out).toContain("allow|allow: 1");
        expect(out).toMatch(/judge latency: p50=5ms/);
        expect(out).not.toContain("audit:");
        expect(out).not.toContain("quarantined rows:");
    });

    it("renders the audit source line in dual-log mode", () => {
        const { enrollments, metrics } = analyze([]);
        const out = capture(() =>
            printReport(
                { ...parsed, audit: "audit.jsonl" },
                enrollments,
                metrics,
            ),
        );
        expect(out).toContain("audit: audit.jsonl (enrollment source, ADR 0006)");
    });

    it("renders the empty-matrix placeholder for an empty log", () => {
        const { enrollments, metrics } = analyze([]);
        const out = capture(() => printReport(parsed, enrollments, metrics));
        expect(out).toContain("(empty)");
        expect(out).toContain("N/A");
    });

    it("renders quarantine categories when integrity faults exist", () => {
        const duplicate: ReviewEvent[] = [
            { event: "authorizer_chain_resolved", requestId: "r1", links: ["ai-bash-judge"] },
            { event: "ai_bash_judge.result", requestId: "r1", resultKind: "judgment", verdict: "allow" },
            { event: "ai_bash_judge.result", requestId: "r1", resultKind: "judgment", verdict: "deny" },
            { event: "permission_request.approved", requestId: "r1", resolution: "approved" },
        ];
        const { enrollments, metrics } = analyze(duplicate);
        const out = capture(() => printReport(parsed, enrollments, metrics));
        expect(out).toContain("quarantined rows:");
        expect(out).toContain("duplicate_result: 1");
    });
});
