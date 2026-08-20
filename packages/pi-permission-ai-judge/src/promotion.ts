import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeSync,
    fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { stripForbiddenKeys } from "./review";

/**
 * Judge-owned promotion-gate records (ADR 0006 self-sufficiency; PIEXTENSIO-10
 * promotion governance; PIEXTENSIO-21 seam).
 *
 * The Enforce truth table consumes three gate inputs — cohort qualification,
 * owner approval, activation — that v0.1 hardcoded to false. This module is
 * their storage and resolution:
 *
 * - **Records file**: append-only JSONL under the agent dir, fsync per
 *   record, same discipline as the audit log. Three record kinds:
 *   `cohort_qualified`, `owner_approval`, `activation`. Owner actions write
 *   records offline (the CLI helper in tools/); the online judge only reads.
 * - **Exact-identity qualification**: a record qualifies the gate only if
 *   its candidate identity matches the live identity field-for-field. A
 *   record for any other identity is inert. This is the PIEXTENSIO-10 rule
 *   that approval binds to the exact candidate, and it makes promotion
 *   immune to identity drift after the records are written.
 * - **Fail-closed everywhere**: missing file, unreadable file, malformed
 *   line, or shape-invalid record ⇒ the gate stays false. No record kind
 *   may flip any gate other than its own. Gates are resolved once at
 *   session start (immutable snapshot for the session), mirroring the
 *   reload-only config contract.
 *
 * Mode is intentionally *not* part of a candidate identity: `mode` is the
 * authority knob (shadow/enforce), while identity is what the records
 * certify. Requiring mode equality would let a shadow cohort qualify an
 * enforce activation record — or vice versa — which the governance
 * explicitly separates.
 */

/** The candidate-identity fields a promotion record must match exactly. */
export interface CandidateIdentity {
    readonly judge: string;
    readonly permissionSystem: string;
    readonly provider: string;
    readonly model: string;
    readonly api: string;
    readonly promptVersion: string;
    readonly toolSchemaVersion: string;
    readonly reviewSchemaVersion: string;
    readonly timeoutCohort: "default" | number;
}

export type PromotionRecordKind =
    | "cohort_qualified"
    | "owner_approval"
    | "activation";

export interface PromotionRecord {
    readonly kind: PromotionRecordKind;
    readonly candidateIdentity: CandidateIdentity;
    /** ISO timestamp written by the record author. */
    readonly recordedAt: string;
    /** Human-readable basis (cohort id, report reference, approval note). */
    readonly basis: string;
}

export interface PromotionRecordsSnapshot {
    /** Shape-valid records parsed from the file (all identities). */
    readonly records: readonly PromotionRecord[];
    /** False when the file exists but is unreadable or has malformed lines. */
    readonly healthy: boolean;
    readonly diagnostic: string | null;
    /** Absolute path of the records file (empty string when unset). */
    readonly path: string;
}

export interface PromotionRecordsDeps {
    /** User-global agent dir (`~/.pi/agent`). */
    readonly agentDir: string;
    /** Injectable reader for tests; defaults to readFileSync(utf-8). */
    readonly readFile?: (path: string) => string;
}

const RECORDS_DIR_SEGMENTS = ["extensions", "pi-permission-ai-judge"];
const RECORDS_FILENAME = "promotion-records.jsonl";

const IDENTITY_KEYS = [
    "judge",
    "permissionSystem",
    "provider",
    "model",
    "api",
    "promptVersion",
    "toolSchemaVersion",
    "reviewSchemaVersion",
    "timeoutCohort",
] as const;

const STRING_IDENTITY_KEYS = IDENTITY_KEYS.filter(
    (key) => key !== "timeoutCohort",
);

export function promotionRecordsPath(agentDir: string): string {
    return join(agentDir, ...RECORDS_DIR_SEGMENTS, RECORDS_FILENAME);
}

function identityMatches(
    record: CandidateIdentity,
    live: CandidateIdentity,
): boolean {
    return IDENTITY_KEYS.every((key) => record[key] === live[key]);
}

function isRecordShape(value: unknown): value is PromotionRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    if (
        record.kind !== "cohort_qualified" &&
        record.kind !== "owner_approval" &&
        record.kind !== "activation"
    ) {
        return false;
    }
    if (
        typeof record.recordedAt !== "string" ||
        record.recordedAt.length === 0
    ) {
        return false;
    }
    if (typeof record.basis !== "string") {
        return false;
    }
    const identity = record.candidateIdentity;
    if (
        typeof identity !== "object" ||
        identity === null ||
        Array.isArray(identity)
    ) {
        return false;
    }
    const identityRecord = identity as Record<string, unknown>;
    // Every field except timeoutCohort is a string; timeoutCohort is
    // "default" or a positive integer (config-cohort semantics).
    const timeoutCohort = identityRecord.timeoutCohort;
    const validTimeoutCohort =
        timeoutCohort === "default" ||
        (typeof timeoutCohort === "number" &&
            Number.isInteger(timeoutCohort) &&
            timeoutCohort > 0);
    if (
        !STRING_IDENTITY_KEYS.every((key) =>
            typeof identityRecord[key] === "string",
        ) ||
        !validTimeoutCohort
    ) {
        return false;
    }
    return true;
}

/**
 * Load and parse the records file once per session (immutable snapshot).
 *
 * Read-only and side-effect free. Malformed or partial state never raises —
 * the snapshot reports `healthy: false`, which `resolvePromotionGates`
 * turns into all-gates-closed. A missing file is the normal pre-promotion
 * state: healthy with zero records.
 */
export function loadPromotionRecords(
    deps: PromotionRecordsDeps,
): PromotionRecordsSnapshot {
    const file = promotionRecordsPath(deps.agentDir);
    const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

    let raw: string;
    try {
        raw = read(file);
    } catch {
        return {
            records: [],
            healthy: true,
            diagnostic: existsSync(file) ? `records unreadable at ${file}` : null,
            path: file,
        };
    }

    const records: PromotionRecord[] = [];
    let malformed = false;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            malformed = true;
            continue;
        }
        if (!isRecordShape(parsed)) {
            malformed = true;
            continue;
        }
        records.push(parsed);
    }

    if (malformed) {
        return {
            records: [],
            healthy: false,
            diagnostic: `malformed records at ${file}`,
            path: file,
        };
    }
    return { records, healthy: true, diagnostic: null, path: file };
}

/** The three Enforce promotion gates for one live candidate identity. */
export interface PromotionGateResolution {
    readonly cohortQualified: boolean;
    readonly ownerApprovalRecorded: boolean;
    readonly activationRecorded: boolean;
}

const ALL_GATES_CLOSED: PromotionGateResolution = {
    cohortQualified: false,
    ownerApprovalRecorded: false,
    activationRecorded: false,
};

/**
 * Resolve the three Enforce promotion gates for the live candidate
 * identity against a session-start records snapshot.
 *
 * Called per ask: the live identity carries the current model segment, so
 * a mid-session model switch cannot inherit another segment's records.
 * Unhealthy snapshot ⇒ all gates closed (fail-closed). A record qualifies
 * only when its candidate identity matches field-for-field; records for
 * any other identity are inert.
 */
export function resolvePromotionGates(
    snapshot: PromotionRecordsSnapshot,
    liveIdentity: CandidateIdentity,
): PromotionGateResolution {
    if (!snapshot.healthy) {
        return ALL_GATES_CLOSED;
    }
    let cohortQualified = false;
    let ownerApprovalRecorded = false;
    let activationRecorded = false;
    for (const record of snapshot.records) {
        if (!identityMatches(record.candidateIdentity, liveIdentity)) {
            continue;
        }
        if (record.kind === "cohort_qualified") cohortQualified = true;
        if (record.kind === "owner_approval") ownerApprovalRecorded = true;
        if (record.kind === "activation") activationRecorded = true;
    }
    return { cohortQualified, ownerApprovalRecorded, activationRecorded };
}

export interface AppendPromotionRecordDeps {
    /** User-global agent dir (`~/.pi/agent`). */
    readonly agentDir: string;
    readonly record: PromotionRecord;
    /** Injectable clock for tests; defaults to ISO-now. */
    readonly now?: () => string;
}

/**
 * Offline owner action: append one promotion record (append + fsync, same
 * write discipline as the audit log). Never imported by online modules —
 * the CLI helper in tools/ is the only in-package consumer.
 *
 * Returns null on success or a human-readable failure reason.
 */
export function appendPromotionRecord(
    deps: AppendPromotionRecordDeps,
): string | null {
    const now = deps.now ?? (() => new Date().toISOString());
    const dir = join(deps.agentDir, ...RECORDS_DIR_SEGMENTS);
    const file = join(dir, RECORDS_FILENAME);
    if (!isRecordShape(deps.record)) {
        return "record is not shape-valid";
    }
    try {
        mkdirSync(dir, { recursive: true });
    } catch (error) {
        return `cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const record = JSON.stringify({
        recordedAt: now(),
        ...stripForbiddenKeys({
            kind: deps.record.kind,
            candidateIdentity: deps.record.candidateIdentity,
            basis: deps.record.basis,
        } as Record<string, unknown>),
    });
    let fd: number | undefined;
    try {
        fd = openSync(file, "a");
        writeSync(fd, `${record}\n`);
        fsyncSync(fd);
        return null;
    } catch (error) {
        return `cannot append to ${file}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {
                // Close failure does not un-fail the append.
            }
        }
    }
}
