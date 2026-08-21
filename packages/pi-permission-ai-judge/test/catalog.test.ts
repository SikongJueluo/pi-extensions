import { describe, expect, it } from "vitest";
import {
    classifyModel,
    loadModelCatalog,
    type CatalogDeps,
} from "../src/catalog";

/**
 * PIEXTENSIO-24: the advisory model catalog shipped with the package.
 * Advisory only — catalog state affects notifications and docs, never
 * Enforce authority (ADR 0008). All expectations are worked literals
 * from the schema, independent of any real entry.
 */

const VALID_ENTRY = {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    api: "openai-codex-responses",
    status: "recommended",
    promptVersion: "bash-shadow-v4",
    corpusVersion: "2026-08-21.1",
    testedAt: "2026-08-21T10:00:00Z",
    corpusCases: 21,
    matched: 21,
    infrastructureFailures: 0,
    latencyMs: { p50: 3000, p95: 9000, max: 12000 },
    reportPath: "reports/corpus-replay-x.json",
};

function depsWith(raw: string | null): CatalogDeps {
    return {
        catalogPath: "/nonexistent-ai-judge-catalog-test/models-catalog.json",
        readFile: (_path: string) => {
            if (raw === null) throw new Error("ENOENT");
            return raw;
        },
    };
}

describe("loadModelCatalog", () => {
    it("loads a valid versioned catalog with frozen entries", () => {
        const { catalog } = run(depsWith(JSON.stringify({
            version: 1,
            entries: [VALID_ENTRY],
        })));
        expect(catalog?.version).toBe(1);
        expect(catalog?.entries).toHaveLength(1);
        expect(catalog?.entries[0]).toMatchObject({
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            status: "recommended",
        });
        expect(Object.isFrozen(catalog?.entries)).toBe(true);
    });

    it("degrades to an empty catalog with a diagnostic on an unknown version", () => {
        const { catalog, diagnostics } = run(depsWith(JSON.stringify({
            version: 99,
            entries: [VALID_ENTRY],
        })));
        expect(catalog?.entries).toEqual([]);
        expect(diagnostics.map((d) => d.key)).toContain("version");
    });

    it("degrades to an empty catalog with a diagnostic on unreadable or malformed files", () => {
        const missing = run(depsWith(null));
        expect(missing.catalog?.entries).toEqual([]);
        expect(missing.diagnostics.map((d) => d.key)).toContain("file");

        const malformed = run(depsWith("{not json"));
        expect(malformed.catalog?.entries).toEqual([]);
        expect(malformed.diagnostics.map((d) => d.key)).toContain("file");
    });

    it("degrades the whole catalog to empty when any entry is invalid", () => {
        const broken = { ...VALID_ENTRY, model: 42 };
        const { catalog, diagnostics } = run(depsWith(JSON.stringify({
            version: 1,
            entries: [broken, VALID_ENTRY],
        })));
        expect(catalog?.entries).toEqual([]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.key).toBe("file");
        expect(String(diagnostics[0]?.problem)).toMatch(/whole catalog degraded/i);
    });
});

describe("classifyModel", () => {
    it("classifies catalog entries by status and unknown models as unlisted", () => {
        const { catalog } = run(depsWith(JSON.stringify({
            version: 1,
            entries: [
                VALID_ENTRY,
                {
                    ...VALID_ENTRY,
                    provider: "prov",
                    model: "old",
                    status: "deprecated",
                },
                {
                    ...VALID_ENTRY,
                    provider: "prov",
                    model: "bad",
                    status: "revoked",
                },
            ],
        })));
        expect(classifyModel(catalog!, "openai-codex", "gpt-5.6-sol")).toBe("recommended");
        expect(classifyModel(catalog!, "prov", "old")).toBe("deprecated");
        expect(classifyModel(catalog!, "prov", "bad")).toBe("revoked");
        expect(classifyModel(catalog!, "openai-codex", "other-model")).toBe("unlisted");
        expect(classifyModel(catalog!, "nope", "gpt-5.6-sol")).toBe("unlisted");
    });

    it("never blocks: classification is pure lookup with no gating semantics", () => {
        const { catalog } = run(depsWith(null));
        expect(catalog?.entries).toEqual([]);
        expect(classifyModel(catalog!, "anything", "anything")).toBe("unlisted");
    });
});

// -- helpers -------------------------------------------------------------

function run(deps: CatalogDeps): {
    catalog: ReturnType<typeof loadModelCatalog>["catalog"];
    diagnostics: ReturnType<typeof loadModelCatalog>["diagnostics"];
} {
    const result = loadModelCatalog(deps);
    return { catalog: result.catalog, diagnostics: result.diagnostics };
}
