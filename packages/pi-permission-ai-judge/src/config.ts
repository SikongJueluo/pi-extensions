import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./model";

/**
 * Judge configuration (PIEXTENSIO-3 Config acceptance, PIEXTENSIO-11
 * configuration contract; version 2 — PIEXTENSIO-23 / ADR 0008).
 *
 * Version 2 adds `model: {provider, id}` — an explicit fixed judge model
 * — and makes hand-written `mode: "enforce"` the user's risk consent. A
 * legacy (version 1 / unversioned) `mode: "enforce"` meant "exact
 * identity certified" under the retired promotion governance; it must not
 * silently gain the new, broader consent, so it fails closed to shadow
 * with a diagnostic requiring one explicit migration to `version: 2`.
 *
 * Everything invalid fails closed to the documented defaults
 * (PIEXTENSIO-11) and records a diagnostic. Global config path only — no
 * project/env override, matching the trusted user-global Judge
 * configuration.
 */

export type JudgeMode = "shadow" | "enforce";

/** A user-selected fixed judge model (config v2). */
export interface JudgeModelSelection {
    readonly provider: string;
    readonly id: string;
}

export interface EffectiveJudgeConfig {
    /** Config schema version the effective values were loaded under. */
    readonly configVersion: 1 | 2;
    readonly mode: JudgeMode;
    readonly timeoutMs: number;
    /**
     * Cohort identity: a non-default timeout is a distinct configuration
     * cohort and never inherits the default cohort's calibration
     * (PIEXTENSIO-11). `default` marks the calibrated default.
     */
    readonly timeoutCohort: "default" | number;
    /** Fixed judge model (v2 only); undefined follows the session model. */
    readonly judgeModel: JudgeModelSelection | undefined;
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
    configVersion: 1,
    mode: "shadow",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    timeoutCohort: "default",
    judgeModel: undefined,
    diagnostics: [],
};

function fileDefaults(problem: string): EffectiveJudgeConfig {
    return {
        ...DEFAULT_CONFIG,
        diagnostics: [{ key: "file", problem, fallback: "all defaults" }],
    };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function parseJudgeModel(value: unknown): JudgeModelSelection | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (!isNonEmptyString(record.provider) || !isNonEmptyString(record.id)) {
        return undefined;
    }
    return {
        provider: record.provider.trim(),
        id: record.id.trim(),
    };
}

/**
 * Load and validate the global config. Missing file, malformed JSON, or
 * an unknown version resolve to the documented defaults with one
 * diagnostic. Version 1 / unversioned files keep v1 semantics except
 * that `enforce` fails closed to shadow pending explicit migration.
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
        return fileDefaults(
            `config not readable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return fileDefaults(
            `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return fileDefaults("top-level value is not an object");
    }

    const record = parsed as Record<string, unknown>;
    const diagnostics: ConfigDiagnostic[] = [];

    // Version: unversioned files are legacy v1; anything but 1 or 2 fails
    // closed to all defaults (the consent expression is uninterpretable).
    let configVersion: 1 | 2 = 1;
    if (record.version !== undefined) {
        if (record.version === 1 || record.version === 2) {
            configVersion = record.version;
        } else {
            return {
                ...DEFAULT_CONFIG,
                diagnostics: [
                    {
                        key: "version",
                        problem: `unknown version ${JSON.stringify(record.version)}`,
                        fallback: "all defaults",
                    },
                ],
            };
        }
    }

    // Mode: unknown or missing resolves to shadow (fail-closed). A v1
    // enforce cannot silently inherit the v2 risk contract (ADR 0008).
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
    if (configVersion === 1 && mode === "enforce") {
        mode = "shadow";
        diagnostics.push({
            key: "mode",
            problem:
                "v1 enforce means certified identity under the retired promotion governance (ADR 0008); add \"version\": 2 to consent to the user-assumed-risk contract",
            fallback: "shadow (v1 enforce requires explicit migration)",
        });
    }

    // Judge model: v2-only. A malformed model poisons the consent file —
    // fail the whole config closed to shadow rather than silently
    // substituting the session model.
    let judgeModel: JudgeModelSelection | undefined;
    if (record.model !== undefined) {
        if (configVersion === 2) {
            judgeModel = parseJudgeModel(record.model);
            if (judgeModel === undefined) {
                mode = "shadow";
                diagnostics.push({
                    key: "model",
                    problem: `invalid model ${JSON.stringify(record.model)} (expected {provider, id} with non-empty strings)`,
                    fallback: "shadow (no judge model)",
                });
            }
        } else {
            diagnostics.push({
                key: "model",
                problem: "model selection requires \"version\": 2",
                fallback: "session model",
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

    return Object.freeze({
        configVersion,
        mode,
        timeoutMs,
        timeoutCohort,
        judgeModel,
        diagnostics,
    });
}
