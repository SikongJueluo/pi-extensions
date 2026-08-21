import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
} from "../src/model";
import { createModelAvailability } from "../src/model";
import {
    applyTimeoutOption,
    replayCorpus,
    selectCorpusCases,
    validateCliState,
    type CliOptions,
} from "../tools/corpus-replay";

/**
 * In-process tests for the corpus-replay harness helpers: option
 * application/validation, case selection, and the replay loop driven by a
 * stub model availability (no registry, no network). The CLI exit contract
 * lives in corpus-replay-cli.test.ts.
 */

function state(overrides: Partial<CliOptions> = {}): { -readonly [K in keyof CliOptions]: CliOptions[K] } {
    return {
        provider: "p",
        model: "m",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        cases: null,
        out: null,
        strict: false,
        ...overrides,
    };
}

describe("applyTimeoutOption", () => {
    it.each([
        [MIN_TIMEOUT_MS, null],
        [MAX_TIMEOUT_MS, null],
        [DEFAULT_TIMEOUT_MS, null],
    ])("accepts the boundary value %i", (value, error) => {
        const s = state();
        expect(applyTimeoutOption(s, String(value))).toBe(error);
        expect(s.timeoutMs).toBe(value);
    });

    it.each([
        [String(MIN_TIMEOUT_MS - 1)],
        [String(MAX_TIMEOUT_MS + 1)],
        ["12.5"],
        ["abc"],
    ])("rejects %s with the documented range error", (value) => {
        const s = state();
        const r = applyTimeoutOption(s, value);
        expect(r).toMatch(/--timeout-ms must be an integer in \[\d+, \d+\]/);
        expect(s.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("rejects a missing value with the range error (the usage check lives in parseArgs)", () => {
        expect(applyTimeoutOption(state(), undefined)).toMatch(/--timeout-ms must be an integer/);
    });
});

describe("validateCliState", () => {
    it("requires both provider and model", () => {
        expect(validateCliState(state({ provider: "" }))).toMatch(/^usage:/);
        expect(validateCliState(state({ model: "" }))).toMatch(/^usage:/);
    });

    it("rejects --strict combined with a --case subset", () => {
        expect(
            validateCliState(state({ strict: true, cases: new Set(["a"]) })),
        ).toContain("--strict requires the full corpus");
    });

    it("accepts a complete valid state", () => {
        expect(validateCliState(state())).toBeNull();
    });
});

describe("selectCorpusCases", () => {
    it("selects the full corpus when no case filter is given", () => {
        const r = selectCorpusCases(null);
        expect("selected" in r && r.selected.length).toBeGreaterThan(10);
    });

    it("selects exactly the requested known ids", () => {
        const r = selectCorpusCases(new Set(["requested-clean", "extra-push"]));
        expect("selected" in r ? r.selected.map((c) => c.id) : []).toEqual([
            "requested-clean",
            "extra-push",
        ]);
    });

    it("errors on unknown ids without selecting anything", () => {
        const r = selectCorpusCases(new Set(["requested-clean", "no-such-case"]));
        expect("error" in r && r.error).toContain("unknown case ids: no-such-case");
    });
});

describe("replayCorpus", () => {
    const stderrSpy = () => vi.spyOn(process.stderr, "write").mockReturnValue(true);

    function availabilityWith(
        respond: () => AssistantMessage,
    ): ReturnType<typeof createModelAvailability> {
        const model = {
            id: "m",
            provider: "p",
            api: "openai-codex-responses",
        } as Model<any>;
        const registry = {
            complete: async (
                _m: Model<any>,
                _c: Context,
                _o?: Record<string, unknown>,
            ) => respond(),
        } as unknown as ModelRegistry;
        return createModelAvailability(model, registry);
    }

    function judgment(verdict: "allow" | "deny" | "defer"): AssistantMessage {
        return {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-1",
                    name: "report_verdict",
                    arguments: { verdict, reason: "stub reason" },
                },
            ],
            api: "openai-codex-responses",
            provider: "p",
            model: "m",
            stopReason: "toolUse",
            usage: {
                input: 10,
                output: 8,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 18,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
        } as AssistantMessage;
    }

    it("counts matches over the selected cases", async () => {
        const spy = stderrSpy();
        try {
            // requested-clean expects allow; extra-push expects defer — one
            // canned judgment cannot satisfy both, so assert row semantics
            // rather than a perfect score.
            const availability = availabilityWith(() => judgment("allow"));
            const selected = selectCorpusCases(
                new Set(["requested-clean", "extra-push"]),
            );
            if (!("selected" in selected)) throw new Error("unreachable");
            const { rows, matched } = await replayCorpus(
                selected.selected,
                availability,
                DEFAULT_TIMEOUT_MS,
                new AbortController().signal,
            );
            expect(rows).toHaveLength(2);
            expect(matched).toBe(1);
            const clean = rows.find((r) => r.case === "requested-clean");
            expect(clean).toMatchObject({ verdict: "allow", match: true });
            const push = rows.find((r) => r.case === "extra-push");
            expect(push).toMatchObject({ verdict: "allow", match: false });
        } finally {
            spy.mockRestore();
        }
    });

    it("records infrastructure failures as unmatched rows", async () => {
        const spy = stderrSpy();
        try {
            const availability = availabilityWith(() => {
                const m = judgment("allow");
                m.stopReason = "error";
                return m;
            });
            const selected = selectCorpusCases(new Set(["requested-clean"]));
            if (!("selected" in selected)) throw new Error("unreachable");
            const { rows, matched } = await replayCorpus(
                selected.selected,
                availability,
                DEFAULT_TIMEOUT_MS,
                new AbortController().signal,
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                verdict: null,
                resultKind: "infrastructure_failure",
                match: false,
            });
            expect(matched).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });
});
