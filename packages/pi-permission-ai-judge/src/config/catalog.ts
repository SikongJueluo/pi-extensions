import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Advisory model catalog (PIEXTENSIO-24, ADR 0008 milestone 2).
 *
 * The catalog is versioned compatibility data shipped with the package:
 * which judge models the owner replayed against the corpus, when, with
 * what results. It is advisory only — it feeds session notifications
 * and documentation and NEVER gates Enforce authority. An out-of-catalog
 * model may still be used for Enforce at the user's own risk; owner
 * testing means structured-output/quality/latency compatibility, not a
 * safety certification.
 *
 * The catalog is hand-maintained data (`models-catalog.json` at the
 * package root, beside `reports/`); no runtime code writes it. Anything
 * unreadable, malformed, or
 * of an unknown schema version — or any single invalid entry — degrades
 * to an empty catalog with a diagnostic: partial recovery would serve
 * unreviewed statuses from a file the owner has not validated, and
 * advisory data must never take the extension down.
 */

export type ModelCatalogStatus = "recommended" | "deprecated" | "revoked";

/** Latency summary as measured by the corpus-replay qualification. */
export interface CatalogLatencySummary {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly max: number | null;
}

/** One owner-tested model entry (summary of a full corpus-replay report). */
export interface ModelCatalogEntry {
    readonly provider: string;
    readonly model: string;
    /** Resolved API of the tested provider segment. */
    readonly api: string;
    readonly status: ModelCatalogStatus;
    readonly promptVersion: string;
    readonly corpusVersion: string;
    readonly testedAt: string;
    readonly corpusCases: number;
    readonly matched: number;
    readonly infrastructureFailures: number;
    readonly latencyMs: CatalogLatencySummary;
    /** Package-relative path to the full replay report (auditable data). */
    readonly reportPath: string;
    readonly notes?: string;
}

export interface LoadedModelCatalog {
    /** Schema version of the catalog file itself. */
    readonly version: number;
    readonly entries: readonly ModelCatalogEntry[];
}

export interface CatalogDiagnostic {
    readonly key: "file" | "version";
    readonly problem: string;
}

export interface CatalogDeps {
    /** Absolute path of the catalog file (injectable for tests). */
    readonly catalogPath: string;
    /** Injectable for tests; defaults to `readFileSync`. */
    readonly readFile?: (path: string) => string;
}

/** Catalog version this module understands. */
const SUPPORTED_CATALOG_VERSION = 1;

const EMPTY_CATALOG: LoadedModelCatalog = Object.freeze({
    version: SUPPORTED_CATALOG_VERSION,
    entries: Object.freeze([]),
});

const LATENCY_KEYS = ["p50", "p95", "max"] as const;

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isLatencySummary(value: unknown): value is CatalogLatencySummary {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return LATENCY_KEYS.every(
        (key) =>
            record[key] === null ||
            (typeof record[key] === "number" && Number.isFinite(record[key])),
    );
}

function parseEntry(value: unknown): ModelCatalogEntry | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const latency = record.latencyMs;
    const valid =
        isNonEmptyString(record.provider) &&
        isNonEmptyString(record.model) &&
        isNonEmptyString(record.api) &&
        (record.status === "recommended" ||
            record.status === "deprecated" ||
            record.status === "revoked") &&
        isNonEmptyString(record.promptVersion) &&
        isNonEmptyString(record.corpusVersion) &&
        isNonEmptyString(record.testedAt) &&
        typeof record.corpusCases === "number" &&
        Number.isInteger(record.corpusCases) &&
        record.corpusCases > 0 &&
        typeof record.matched === "number" &&
        Number.isInteger(record.matched) &&
        typeof record.infrastructureFailures === "number" &&
        Number.isInteger(record.infrastructureFailures) &&
        isLatencySummary(latency) &&
        isNonEmptyString(record.reportPath) &&
        (record.notes === undefined || isNonEmptyString(record.notes));
    if (!valid) {
        return null;
    }
    const entry: ModelCatalogEntry = {
        provider: record.provider as string,
        model: record.model as string,
        api: record.api as string,
        status: record.status as ModelCatalogStatus,
        promptVersion: record.promptVersion as string,
        corpusVersion: record.corpusVersion as string,
        testedAt: record.testedAt as string,
        corpusCases: record.corpusCases as number,
        matched: record.matched as number,
        infrastructureFailures: record.infrastructureFailures as number,
        latencyMs: latency as CatalogLatencySummary,
        reportPath: record.reportPath as string,
        ...(record.notes === undefined
            ? {}
            : { notes: record.notes as string }),
    };
    return Object.freeze(entry);
}

/** Load and validate the advisory catalog; failures degrade to empty. */
export function loadModelCatalog(deps: CatalogDeps): {
    readonly catalog: LoadedModelCatalog;
    readonly diagnostics: readonly CatalogDiagnostic[];
} {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    let raw: string;
    try {
        raw = read(deps.catalogPath);
    } catch (error) {
        return {
            catalog: EMPTY_CATALOG,
            diagnostics: [
                {
                    key: "file",
                    problem: `catalog not readable at ${deps.catalogPath}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                },
            ],
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return {
            catalog: EMPTY_CATALOG,
            diagnostics: [
                {
                    key: "file",
                    problem: `malformed catalog JSON: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                },
            ],
        };
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).version !== "number"
    ) {
        return {
            catalog: EMPTY_CATALOG,
            diagnostics: [
                { key: "version", problem: "catalog is not a versioned object" },
            ],
        };
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== SUPPORTED_CATALOG_VERSION) {
        return {
            catalog: EMPTY_CATALOG,
            diagnostics: [
                {
                    key: "version",
                    problem: `unknown catalog version ${JSON.stringify(record.version)} (supported: ${SUPPORTED_CATALOG_VERSION})`,
                },
            ],
        };
    }

    const diagnostics: CatalogDiagnostic[] = [];
    if (!Array.isArray(record.entries)) {
        return {
            catalog: EMPTY_CATALOG,
            diagnostics: [
                {
                    key: "file",
                    problem: "catalog entries missing or not an array",
                },
            ],
        };
    }
    const entries: ModelCatalogEntry[] = [];
    for (let index = 0; index < record.entries.length; index += 1) {
        const entry = parseEntry(record.entries[index]);
        if (entry === null) {
            return {
                catalog: EMPTY_CATALOG,
                diagnostics: [
                    {
                        key: "file",
                        problem: `entry ${index} invalid; whole catalog degraded to empty`,
                    },
                ],
            };
        }
        entries.push(entry);
    }
    return {
        catalog: Object.freeze({
            version: record.version as number,
            entries: Object.freeze(entries),
        }),
        diagnostics: Object.freeze(diagnostics),
    };
}

export type ModelCatalogClassification = ModelCatalogStatus | "unlisted";

/**
 * Pure lookup of a model's advisory catalog status. This classification
 * exists for notifications and docs only; callers must not use it to
 * gate anything.
 */
export function classifyModel(
    catalog: LoadedModelCatalog,
    provider: string,
    model: string,
): ModelCatalogClassification {
    for (const entry of catalog.entries) {
        if (entry.provider === provider && entry.model === model) {
            return entry.status;
        }
    }
    return "unlisted";
}

/** Package-root catalog path (data, not source; beside reports/). */
export const DEFAULT_CATALOG_PATH: string = fileURLToPath(
    new URL("../../models-catalog.json", import.meta.url),
);
