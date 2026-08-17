import { describe, expect, it } from "vitest";
import { loadJudgeConfig, type ConfigLoadDeps } from "../src/config";

function deps(files: Record<string, string> = {}): ConfigLoadDeps {
    return {
        agentDir: "/agent",
        readFile: (path: string) => {
            const content = files[path];
            if (content === undefined) {
                throw new Error("ENOENT");
            }
            return content;
        },
    };
}

const CONFIG_PATH = "/agent/pi-permission-ai-judge.config.json";

describe("loadJudgeConfig — missing and malformed", () => {
    it("resolves a missing file to all defaults with one diagnostic", () => {
        const config = loadJudgeConfig(deps());
        expect(config).toEqual({
            mode: "shadow",
            timeoutMs: 15_000,
            timeoutCohort: "default",
            diagnostics: [
                expect.objectContaining({ key: "file", fallback: "all defaults" }),
            ],
        });
    });

    it("resolves malformed JSON to defaults", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: "{ not json" }),
        );
        expect(config.mode).toBe("shadow");
        expect(config.timeoutMs).toBe(15_000);
        expect(config.diagnostics[0]?.key).toBe("file");
    });

    it("resolves a non-object top level to defaults", () => {
        const config = loadJudgeConfig(deps({ [CONFIG_PATH]: "[1,2,3]" }));
        expect(config.mode).toBe("shadow");
        expect(config.diagnostics[0]?.key).toBe("file");
    });
});

describe("loadJudgeConfig — mode", () => {
    it("accepts shadow and enforce", () => {
        expect(
            loadJudgeConfig(deps({ [CONFIG_PATH]: '{"mode":"shadow"}' })).mode,
        ).toBe("shadow");
        expect(
            loadJudgeConfig(deps({ [CONFIG_PATH]: '{"mode":"enforce"}' })).mode,
        ).toBe("enforce");
    });

    it("resolves an unknown mode to shadow with a diagnostic", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"mode":"yolo"}' }),
        );
        expect(config.mode).toBe("shadow");
        expect(config.diagnostics).toEqual([
            {
                key: "mode",
                problem: 'unknown mode "yolo"',
                fallback: "shadow",
            },
        ]);
    });

    it("resolves a missing mode to shadow without diagnostics", () => {
        const config = loadJudgeConfig(deps({ [CONFIG_PATH]: "{}" }));
        expect(config.mode).toBe("shadow");
        expect(config.diagnostics).toEqual([]);
    });
});

describe("loadJudgeConfig — timeout boundaries", () => {
    it.each([4_999, 30_001, 0, -5_000, 15.5, NaN, Infinity, "20000"])(
        "rejects invalid timeoutMs %p with fallback to 15,000",
        (value) => {
            const config = loadJudgeConfig(
                deps({ [CONFIG_PATH]: JSON.stringify({ timeoutMs: value }) }),
            );
            expect(config.timeoutMs).toBe(15_000);
            expect(config.timeoutCohort).toBe("default");
            expect(config.diagnostics[0]?.key).toBe("timeoutMs");
        },
    );

    it("accepts the inclusive boundaries 5,000 and 30,000", () => {
        expect(
            loadJudgeConfig(deps({ [CONFIG_PATH]: '{"timeoutMs":5000}' })),
        ).toMatchObject({ timeoutMs: 5_000, timeoutCohort: 5_000 });
        expect(
            loadJudgeConfig(deps({ [CONFIG_PATH]: '{"timeoutMs":30000}' })),
        ).toMatchObject({ timeoutMs: 30_000, timeoutCohort: 30_000 });
    });

    it("marks an explicit default timeout as the default cohort", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"timeoutMs":15000}' }),
        );
        expect(config.timeoutCohort).toBe("default");
        expect(config.diagnostics).toEqual([]);
    });

    it("marks a non-default timeout as a distinct cohort", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"timeoutMs":30000}' }),
        );
        expect(config.timeoutCohort).toBe(30_000);
    });
});

describe("loadJudgeConfig — snapshot immutability", () => {
    it("returns an immutable effective-config snapshot", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"mode":"enforce","timeoutMs":20000}' }),
        );
        expect(Object.isFrozen(config)).toBe(true);
        expect(config).toEqual({
            mode: "enforce",
            timeoutMs: 20_000,
            timeoutCohort: 20_000,
            diagnostics: [],
        });
    });
});
