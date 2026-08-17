import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./model";

/**
 * Judge configuration (PIEXTENSIO-3 Config acceptance, PIEXTENSIO-11
 * configuration contract).
 *
 * The single user-configurable field is `timeoutMs` because acceptable
 * interactive wait varies by deployment. Mode is read but v0.1 authority is
 * mechanically fail-closed: `enforce` loads but the judge truth table
 * (PIEXTENSIO-12) can never produce real authority until the promotion
 * gates exist upstream, so it always defers.
 *
 * Global config path only — no project/env override, matching the trusted
 * user-global Judge configuration of PIEXTENSIO-10.
 */

export type JudgeMode = "shadow" | "enforce";

export interface EffectiveJudgeConfig {
    readonly mode: JudgeMode;
    readonly timeoutMs: number;
    /**
     * Cohort identity: a non-default timeout is a distinct configuration
     * cohort and never inherits the default cohort's calibration
     * (PIEXTENSIO-11). `default` marks the calibrated default.
     */
    readonly timeoutCohort: "default" | number;
    /** Validation diagnostics for the loaded raw file, newest wins per key. */
    readonly diagnostics: readonly ConfigDiagnostic[];
}

export interface ConfigDiagnostic {
    readonly key: string;
    readonly problem: string;
    readonly fallback: string;
}

export interface ConfigLoadDeps {
    /** User-global agent dir (`~/.pi/agent`). */
    readonly agentDir: string;
    /** Injectable for tests; defaults to `readFileSync`. */
    readonly readFile?: (path: string) => string;
}

const CONFIG_FILENAME = "pi-permission-ai-judge.config.json";
const DEFAULT_CONFIG: EffectiveJudgeConfig = {
    mode: "shadow",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    timeoutCohort: "default",
    diagnostics: [],
};

/**
 * Load and validate the global config. Missing file, malformed JSON,
 * unknown mode, or out-of-range timeout all fail closed to the documented
 * defaults (PIEXTENSIO-11: "invalid values fail closed to the documented
 * default rather than becoming unbounded") and record a diagnostic.
 */
export function loadJudgeConfig(
    deps: ConfigLoadDeps,
): EffectiveJudgeConfig {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    const path = join(deps.agentDir, CONFIG_FILENAME);
    let raw: string;
    try {
        raw = read(path);
    } catch (error) {
        return {
            ...DEFAULT_CONFIG,
            diagnostics: [
                {
                    key: "file",
                    problem: `config not readable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
                    fallback: "all defaults",
                },
            ],
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return {
            ...DEFAULT_CONFIG,
            diagnostics: [
                {
                    key: "file",
                    problem: `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
                    fallback: "all defaults",
                },
            ],
        };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
            ...DEFAULT_CONFIG,
            diagnostics: [
                {
                    key: "file",
                    problem: "top-level value is not an object",
                    fallback: "all defaults",
                },
            ],
        };
    }

    const record = parsed as Record<string, unknown>;
    const diagnostics: ConfigDiagnostic[] = [];

    // Mode: unknown or missing resolves to shadow (fail-closed).
    let mode: JudgeMode = "shadow";
    if (record.mode !== undefined) {
        if (record.mode === "shadow" || record.mode === "enforce") {
            mode = record.mode;
        } else {
            diagnostics.push({
                key: "mode",
                problem: `unknown mode ${JSON.stringify(record.mode)}`,
                fallback: "shadow",
            });
        }
    }

    // Timeout: integers in [5_000, 30_000]; anything else falls back to the
    // documented 15,000 ms default. Boundary semantics: 4,999 and 30,001
    // are invalid, 5,000 and 30,000 are valid (PIEXTENSIO-3 boundaries).
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    let timeoutCohort: EffectiveJudgeConfig["timeoutCohort"] = "default";
    if (record.timeoutMs !== undefined) {
        const value = record.timeoutMs;
        if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= MIN_TIMEOUT_MS &&
            value <= MAX_TIMEOUT_MS
        ) {
            timeoutMs = value;
            timeoutCohort = value === DEFAULT_TIMEOUT_MS ? "default" : value;
        } else {
            diagnostics.push({
                key: "timeoutMs",
                problem: `invalid timeoutMs ${JSON.stringify(value)}`,
                fallback: `${DEFAULT_TIMEOUT_MS} (default)`,
            });
        }
    }

    return Object.freeze({ mode, timeoutMs, timeoutCohort, diagnostics });
}