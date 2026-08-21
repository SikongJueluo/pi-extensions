import { describe, expect, it } from "vitest";
import { loadJudgeConfig, type ConfigLoadDeps } from "../src/config/judge";

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
            configVersion: 1,
            mode: "shadow",
            timeoutMs: 15_000,
            timeoutCohort: "default",
            judgeModel: undefined,
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

describe("loadJudgeConfig — version selection", () => {
    it("treats a missing version as v1", () => {
        const config = loadJudgeConfig(deps({ [CONFIG_PATH]: '{"mode":"shadow"}' }));
        expect(config.configVersion).toBe(1);
    });

    it("accepts version 1 explicitly", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"version":1,"mode":"shadow"}' }),
        );
        expect(config.configVersion).toBe(1);
        expect(config.diagnostics).toEqual([]);
    });

    it("accepts version 2", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"version":2,"mode":"shadow"}' }),
        );
        expect(config.configVersion).toBe(2);
        expect(config.diagnostics).toEqual([]);
    });

    it("rejects an unknown version to all defaults with a diagnostic", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"version":3,"mode":"enforce"}' }),
        );
        expect(config).toMatchObject({ configVersion: 1, mode: "shadow" });
        expect(config.diagnostics[0]?.key).toBe("version");
    });
});

describe("loadJudgeConfig — v1 enforce migration (fail-closed)", () => {
    it("downgrades v1 enforce to shadow with a migration diagnostic", () => {
        for (const raw of ['{"mode":"enforce"}', '{"version":1,"mode":"enforce"}']) {
            const config = loadJudgeConfig(deps({ [CONFIG_PATH]: raw }));
            expect(config.mode).toBe("shadow");
            expect(config.diagnostics).toEqual([
                {
                    key: "mode",
                    problem: expect.stringMatching(/"version": 2/),
                    fallback: "shadow (v1 enforce requires explicit migration)",
                },
            ]);
        }
    });

    it("keeps v1 shadow without diagnostics", () => {
        const config = loadJudgeConfig(deps({ [CONFIG_PATH]: '{"mode":"shadow"}' }));
        expect(config.mode).toBe("shadow");
        expect(config.diagnostics).toEqual([]);
    });
});

describe("loadJudgeConfig — mode", () => {
    it("accepts shadow and enforce in v2", () => {
        expect(
            loadJudgeConfig(
                deps({ [CONFIG_PATH]: '{"version":2,"mode":"shadow"}' }),
            ).mode,
        ).toBe("shadow");
        expect(
            loadJudgeConfig(
                deps({ [CONFIG_PATH]: '{"version":2,"mode":"enforce"}' }),
            ).mode,
        ).toBe("enforce");
    });

    it("resolves an unknown mode to shadow with a diagnostic", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"version":2,"mode":"yolo"}' }),
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
        const config = loadJudgeConfig(deps({ [CONFIG_PATH]: '{"version":2}' }));
        expect(config.mode).toBe("shadow");
        expect(config.diagnostics).toEqual([]);
    });
});

describe("loadJudgeConfig — v2 judge model", () => {
    it("parses an explicit fixed judge model", () => {
        const config = loadJudgeConfig(
            deps({
                [CONFIG_PATH]:
                    '{"version":2,"mode":"enforce","model":{"provider":"openai-codex","id":"gpt-5.6-sol"}}',
            }),
        );
        expect(config.mode).toBe("enforce");
        expect(config.judgeModel).toEqual({
            provider: "openai-codex",
            id: "gpt-5.6-sol",
        });
        expect(config.diagnostics).toEqual([]);
    });

    it("allows a judge model in shadow mode too", () => {
        const config = loadJudgeConfig(
            deps({
                [CONFIG_PATH]:
                    '{"version":2,"mode":"shadow","model":{"provider":"p","id":"m"}}',
            }),
        );
        expect(config.mode).toBe("shadow");
        expect(config.judgeModel).toEqual({ provider: "p", id: "m" });
    });

    it.each([
        '{"version":2,"model":"openai-codex"}',
        '{"version":2,"model":{"provider":"p"}}',
        '{"version":2,"model":{"id":"m"}}',
        '{"version":2,"model":{"provider":"","id":"m"}}',
        '{"version":2,"model":{"provider":"p","id":""}}',
        '{"version":2,"model":{"provider":1,"id":"m"}}',
        '{"version":2,"model":[]}',
    ])("fails a malformed model %j closed to shadow with a diagnostic", (raw) => {
        const config = loadJudgeConfig(deps({ [CONFIG_PATH]: raw }));
        expect(config.mode).toBe("shadow");
        expect(config.judgeModel).toBeUndefined();
        expect(config.diagnostics[0]?.key).toBe("model");
    });

    it("ignores a model field in v1 with a diagnostic", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"model":{"provider":"p","id":"m"}}' }),
        );
        expect(config.configVersion).toBe(1);
        expect(config.judgeModel).toBeUndefined();
        expect(config.diagnostics[0]?.key).toBe("model");
    });
});

describe("loadJudgeConfig — timeout boundaries", () => {
    it.each([4_999, 30_001, 0, -5_000, 15.5, NaN, Infinity, "20000"])(
        "rejects invalid timeoutMs %p with fallback to 15,000",
        (value) => {
            const config = loadJudgeConfig(
                deps({
                    [CONFIG_PATH]: JSON.stringify({ version: 2, timeoutMs: value }),
                }),
            );
            expect(config.timeoutMs).toBe(15_000);
            expect(config.timeoutCohort).toBe("default");
            expect(config.diagnostics[0]?.key).toBe("timeoutMs");
        },
    );

    it("accepts the inclusive boundaries 5,000 and 30,000", () => {
        expect(
            loadJudgeConfig(
                deps({ [CONFIG_PATH]: '{"version":2,"timeoutMs":5000}' }),
            ),
        ).toMatchObject({ timeoutMs: 5_000, timeoutCohort: 5_000 });
        expect(
            loadJudgeConfig(
                deps({ [CONFIG_PATH]: '{"version":2,"timeoutMs":30000}' }),
            ),
        ).toMatchObject({ timeoutMs: 30_000, timeoutCohort: 30_000 });
    });

    it("marks an explicit default timeout as the default cohort", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"version":2,"timeoutMs":15000}' }),
        );
        expect(config.timeoutCohort).toBe("default");
        expect(config.diagnostics).toEqual([]);
    });

    it("marks a non-default timeout as a distinct cohort", () => {
        const config = loadJudgeConfig(
            deps({ [CONFIG_PATH]: '{"version":2,"timeoutMs":30000}' }),
        );
        expect(config.timeoutCohort).toBe(30_000);
    });
});

describe("loadJudgeConfig — snapshot immutability", () => {
    it("returns an immutable effective-config snapshot", () => {
        const config = loadJudgeConfig(
            deps({
                [CONFIG_PATH]:
                    '{"version":2,"mode":"enforce","timeoutMs":20000,"model":{"provider":"p","id":"m"}}',
            }),
        );
        expect(Object.isFrozen(config)).toBe(true);
        expect(config).toEqual({
            configVersion: 2,
            mode: "enforce",
            timeoutMs: 20_000,
            timeoutCohort: 20_000,
            judgeModel: { provider: "p", id: "m" },
            diagnostics: [],
        });
    });
});
