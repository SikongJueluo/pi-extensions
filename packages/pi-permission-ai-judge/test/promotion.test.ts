import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    appendPromotionRecord,
    loadPromotionRecords,
    promotionRecordsPath,
    resolvePromotionGates,
    type CandidateIdentity,
    type PromotionRecord,
} from "../src/promotion";

const IDENTITY: CandidateIdentity = {
    judge: "@sikongjueluo/pi-permission-ai-judge@0.0.1",
    permissionSystem: "25.4.0",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    api: "openai-codex-responses",
    promptVersion: "bash-shadow-v4",
    toolSchemaVersion: "report-verdict-v1",
    reviewSchemaVersion: "1",
    timeoutCohort: 30000,
};

function record(
    kind: PromotionRecord["kind"],
    identity: CandidateIdentity = IDENTITY,
    basis = "test basis",
): PromotionRecord {
    return {
        kind,
        candidateIdentity: identity,
        recordedAt: "2026-08-20T12:00:00Z",
        basis,
    };
}

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

/** writeFileSync, but creating the records directory first. */
function writeRecords(dir: string, content: string): void {
    const path = promotionRecordsPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

describe("promotion records — loadPromotionRecords", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "ai-judge-promotion-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("treats a missing file as the healthy pre-promotion state", () => {
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot).toEqual({
            records: [],
            healthy: true,
            diagnostic: null,
            path: promotionRecordsPath(dir),
        });
    });

    it("parses well-formed records of every kind", () => {
        writeRecords(
            dir,
            [record("cohort_qualified"), record("owner_approval"), record("activation")]
                .map(line)
                .join(""),
        );
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(true);
        expect(snapshot.records).toHaveLength(3);
        expect(snapshot.records.map((r) => r.kind)).toEqual([
            "cohort_qualified",
            "owner_approval",
            "activation",
        ]);
    });

    it("fails closed on malformed JSON lines", () => {
        writeRecords(
            dir,
            line(record("cohort_qualified")) + "{not json\n",
        );
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(false);
        expect(snapshot.records).toEqual([]);
        expect(snapshot.diagnostic).toContain("malformed");
    });

    it("fails closed on shape-invalid records", () => {
        writeRecords(
            dir,
            line({ kind: "activation" }), // missing identity/basis/recordedAt
        );
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(false);
        expect(snapshot.diagnostic).toContain("malformed");
    });

    it("skips blank lines without failing", () => {
        writeRecords(
            dir,
            "\n" + line(record("activation")) + "\n\n",
        );
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(true);
        expect(snapshot.records).toHaveLength(1);
    });
});

describe("promotion records — resolvePromotionGates", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "ai-judge-promotion-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("flips only its own gate per record kind", () => {
        writeRecords(dir, line(record("owner_approval")));
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(resolvePromotionGates(snapshot, IDENTITY)).toEqual({
            cohortQualified: false,
            ownerApprovalRecorded: true,
            activationRecorded: false,
        });
    });

    it("all three gates open with all three records for the exact identity", () => {
        writeRecords(
            dir,
            [
                record("cohort_qualified", IDENTITY, "cohort id x"),
                record("owner_approval", IDENTITY, "approved"),
                record("activation", IDENTITY, "activated"),
            ]
                .map(line)
                .join(""),
        );
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(resolvePromotionGates(snapshot, IDENTITY)).toEqual({
            cohortQualified: true,
            ownerApprovalRecorded: true,
            activationRecorded: true,
        });
    });

    const identityDrifts: ReadonlyArray<[string, Partial<CandidateIdentity>]> = [
        ["provider", { provider: "other-provider" }],
        ["model", { model: "gpt-5.7" }],
        ["api", { api: "openai-responses" }],
        ["promptVersion", { promptVersion: "bash-shadow-v5" }],
        ["toolSchemaVersion", { toolSchemaVersion: "report-verdict-v2" }],
        ["reviewSchemaVersion", { reviewSchemaVersion: "2" }],
        ["timeoutCohort", { timeoutCohort: "default" }],
        ["permissionSystem", { permissionSystem: "25.5.0" }],
        ["judge package", { judge: "@sikongjueluo/pi-permission-ai-judge@0.0.2" }],
    ];
    for (const [name, patch] of identityDrifts) {
        it(`keeps every gate closed when the live identity drifts on ${name}`, () => {
            writeRecords(
                dir,
                [
                    record("cohort_qualified"),
                    record("owner_approval"),
                    record("activation"),
                ]
                    .map(line)
                    .join(""),
            );
            const snapshot = loadPromotionRecords({ agentDir: dir });
            expect(
                resolvePromotionGates(snapshot, { ...IDENTITY, ...patch }),
            ).toEqual({
                cohortQualified: false,
                ownerApprovalRecorded: false,
                activationRecorded: false,
            });
        });
    }

    it("closes every gate when the snapshot is unhealthy", () => {
        writeRecords(dir, "garbage\n");
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(false);
        expect(resolvePromotionGates(snapshot, IDENTITY)).toEqual({
            cohortQualified: false,
            ownerApprovalRecorded: false,
            activationRecorded: false,
        });
    });

    it("leaves other-identity records inert, not malformed", () => {
        const other: CandidateIdentity = {
            ...IDENTITY,
            model: "glm-5.2",
        };
        writeRecords(
            dir,
            [
                record("cohort_qualified", other),
                record("activation", other),
            ]
                .map(line)
                .join(""),
        );
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(true);
        expect(resolvePromotionGates(snapshot, IDENTITY)).toEqual({
            cohortQualified: false,
            ownerApprovalRecorded: false,
            activationRecorded: false,
        });
    });
});

describe("promotion records — appendPromotionRecord", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "ai-judge-promotion-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("appends a shape-valid record that round-trips through the loader", () => {
        const error = appendPromotionRecord({
            agentDir: dir,
            record: record("owner_approval", IDENTITY, "approved v4"),
            now: () => "2026-08-21T09:00:00Z",
        });
        expect(error).toBeNull();
        const raw = readFileSync(promotionRecordsPath(dir), "utf-8");
        expect(raw).toContain('"recordedAt":"2026-08-21T09:00:00Z"');
        expect(raw).toContain('"basis":"approved v4"');
        const snapshot = loadPromotionRecords({ agentDir: dir });
        expect(snapshot.healthy).toBe(true);
        expect(resolvePromotionGates(snapshot, IDENTITY).ownerApprovalRecorded).toBe(true);
    });

    it("rejects a shape-invalid record without touching the file", () => {
        const bad = {
            kind: "activation",
            candidateIdentity: { judge: "x" },
            recordedAt: "",
            basis: "",
        } as unknown as PromotionRecord;
        const error = appendPromotionRecord({ agentDir: dir, record: bad });
        expect(error).toBe("record is not shape-valid");
        expect(loadPromotionRecords({ agentDir: dir }).records).toEqual([]);
    });
});
