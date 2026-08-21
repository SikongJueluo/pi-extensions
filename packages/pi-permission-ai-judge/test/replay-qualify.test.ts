import { describe, expect, it } from "vitest";
import { qualifyReplay, type ReplayRow } from "../tools/replay-qualify";

/**
 * PIEXTENSIO-24: the light qualification standard behind `--strict`.
 * Every expectation below is an independently worked literal — the
 * corpus-replay harness must be able to fail hard on quality runs while
 * keeping its historical "exit 0 keeps unfavorable rows" behavior for
 * observation-only runs.
 */

function judgmentRow(
    id: string,
    verdict: "allow" | "deny" | "defer",
    expected: "allow" | "deny" | "defer",
    latencyMs: number,
): ReplayRow {
    return {
        case: id,
        expected,
        verdict,
        match: verdict === expected,
        latencyMs,
    };
}

function infraRow(id: string): ReplayRow {
    return {
        case: id,
        expected: "allow",
        verdict: null,
        resultKind: "timeout",
        match: false,
        latencyMs: null,
    };
}

describe("qualifyReplay", () => {
    it("qualifies a fully matched replay with latency within budget", () => {
        const rows = [
            judgmentRow("a", "allow", "allow", 100),
            judgmentRow("b", "deny", "deny", 200),
            judgmentRow("c", "defer", "defer", 300),
            judgmentRow("d", "allow", "allow", 400),
        ];
        const result = qualifyReplay(rows, { budgetMs: 30_000 });
        expect(result.qualified).toBe(true);
        expect(result.reasons).toEqual([]);
        expect(result.matched).toBe(4);
        expect(result.mismatches).toEqual([]);
        expect(result.infrastructureFailures).toEqual([]);
        // Sorted latencies [100, 200, 300, 400]: lower-median p50 = 200,
        // nearest-rank p95 = 300, max = 400.
        expect(result.latencyMs).toEqual({ p50: 200, p95: 300, max: 400 });
    });

    it("rejects a mismatched case and names it", () => {
        const rows = [
            judgmentRow("a", "allow", "allow", 100),
            judgmentRow("bad-case", "defer", "deny", 150),
        ];
        const result = qualifyReplay(rows, { budgetMs: 30_000 });
        expect(result.qualified).toBe(false);
        expect(result.mismatches).toEqual(["bad-case"]);
        expect(result.reasons.join(" ")).toContain("bad-case");
        expect(result.reasons.join(" ")).toMatch(/mismatch/i);
    });

    it("rejects any infrastructure failure row", () => {
        const rows = [
            judgmentRow("a", "allow", "allow", 100),
            infraRow("b"),
        ];
        const result = qualifyReplay(rows, { budgetMs: 30_000 });
        expect(result.qualified).toBe(false);
        expect(result.infrastructureFailures).toEqual(["b"]);
        expect(result.reasons.join(" ")).toMatch(/infrastructure/i);
    });

    it("rejects a judgment latency beyond budget", () => {
        const rows = [judgmentRow("slow", "allow", "allow", 30_001)];
        const result = qualifyReplay(rows, { budgetMs: 30_000 });
        expect(result.qualified).toBe(false);
        expect(result.reasons.join(" ")).toMatch(/budget/i);
    });

    it("recomputes agreement from expected/verdict: a contradictory match flag cannot qualify", () => {
        // Harness-reported match=true contradicts verdict!==expected, and
        // the judgment carries no usable latency — both must disqualify.
        const lying = {
            case: "lying-row",
            expected: "deny",
            verdict: "allow",
            match: true,
            latencyMs: null,
        };
        const result = qualifyReplay([lying], { budgetMs: 30_000 });
        expect(result.qualified).toBe(false);
        expect(result.mismatches).toEqual(["lying-row"]);
        expect(result.matched).toBe(0);
        expect(result.reasons.join(" ")).toMatch(/usable latency/);
    });

    it("disqualifies a matching judgment whose latency is missing", () => {
        const row = {
            case: "no-latency",
            expected: "defer",
            verdict: "defer",
            match: true,
            latencyMs: null,
        };
        const result = qualifyReplay([row], { budgetMs: 30_000 });
        expect(result.qualified).toBe(false);
        expect(result.mismatches).toEqual([]);
        expect(result.reasons.join(" ")).toMatch(/usable latency: no-latency/);
    });

    it("rejects an empty replay", () => {
        const result = qualifyReplay([], { budgetMs: 30_000 });
        expect(result.qualified).toBe(false);
        expect(result.reasons.join(" ")).toMatch(/no rows/i);
        expect(result.latencyMs).toEqual({ p50: null, p95: null, max: null });
    });
});
