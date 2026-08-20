/**
 * PIEXTENSIO-21 owner action CLI (offline, package-local).
 *
 * Appends one promotion record to the Judge-owned records file
 * (~/.pi/agent/extensions/pi-permission-ai-judge/promotion-records.jsonl).
 * Never imported by online modules; no npm bin. The three record kinds map
 * one-to-one to the Enforce truth-table promotion gates:
 *
 *   cohort_qualified — after a declared replacement cohort meets the frozen
 *                      floor, citing the cohort id + report reference
 *   owner_approval   — the owner's explicit approval of that exact candidate
 *   activation       — the distinct, explicit activation act
 *
 * Fail-closed contract: a record qualifies only its exact candidate
 * identity; the judge re-derives identity from the live runtime, so a
 * mismatched or malformed record is inert and malformed files close all
 * gates. There is no CLI to *remove* authority records by design —
 * rollback to Shadow is the config `mode` switch, and the append-only
 * trail keeps the promotion history auditable.
 *
 * Usage:
 *   npx tsx tools/promotion-record.ts --kind cohort_qualified \
 *     --provider openai-codex --model gpt-5.6-sol --api openai-codex-responses \
 *     [--timeout-cohort 30000] --basis "cohort <id>; report docs/testing/..."
 *
 * judge/permission-system/prompt/tool-schema/review-schema versions are
 * taken from the live package (src/prompt.ts + package constants) so the
 * recorded identity cannot drift from the code that will check it.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    appendPromotionRecord,
    promotionRecordsPath,
    type CandidateIdentity,
    type PromotionRecordKind,
} from "../src/promotion";
import { PROMPT_VERSION, TOOL_SCHEMA_VERSION } from "../src/prompt";

const JUDGE_IDENTITY = "@sikongjueluo/pi-permission-ai-judge@0.0.1";
const PERMISSION_SYSTEM_VERSION = "25.4.0";
const REVIEW_SCHEMA_VERSION = "1";

interface CliOptions {
    kind: PromotionRecordKind;
    provider: string;
    model: string;
    api: string;
    timeoutCohort: "default" | number;
    basis: string;
}

function usage(): string {
    return [
        "usage: promotion-record --kind <cohort_qualified|owner_approval|activation>",
        "                    --provider <p> --model <m> --api <api>",
        "                    [--timeout-cohort default|<ms>] --basis <text>",
    ].join("\n");
}

function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
    const args = argv.slice(2);
    const opts: Partial<CliOptions> = {};
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] as string;
        const value = args[i + 1];
        if (
            arg === "--kind" ||
            arg === "--provider" ||
            arg === "--model" ||
            arg === "--api" ||
            arg === "--basis"
        ) {
            if (value === undefined) return { error: `${arg} requires a value` };
            if (arg === "--kind") {
                if (
                    value !== "cohort_qualified" &&
                    value !== "owner_approval" &&
                    value !== "activation"
                ) {
                    return { error: `unknown kind: ${value}` };
                }
                opts.kind = value;
            }
            if (arg === "--provider") opts.provider = value;
            if (arg === "--model") opts.model = value;
            if (arg === "--api") opts.api = value;
            if (arg === "--basis") opts.basis = value;
            i += 1;
            continue;
        }
        if (arg === "--timeout-cohort") {
            if (value === undefined) return { error: `${arg} requires a value` };
            if (value === "default") {
                opts.timeoutCohort = "default";
            } else {
                const n = Number(value);
                if (!Number.isInteger(n)) {
                    return { error: `--timeout-cohort must be default or an integer` };
                }
                opts.timeoutCohort = n;
            }
            i += 1;
            continue;
        }
        return { error: `unknown option: ${arg}\n${usage()}` };
    }
    if (
        opts.kind === undefined ||
        opts.provider === undefined ||
        opts.model === undefined ||
        opts.api === undefined ||
        opts.basis === undefined ||
        opts.basis.length === 0
    ) {
        return { error: usage() };
    }
    return {
        kind: opts.kind,
        provider: opts.provider,
        model: opts.model,
        api: opts.api,
        timeoutCohort: opts.timeoutCohort ?? "default",
        basis: opts.basis,
    };
}

function main(): number {
    const parsed = parseArgs(process.argv);
    if ("error" in parsed) {
        process.stderr.write(`${parsed.error}\n`);
        return 1;
    }
    const identity: CandidateIdentity = {
        judge: JUDGE_IDENTITY,
        permissionSystem: PERMISSION_SYSTEM_VERSION,
        provider: parsed.provider,
        model: parsed.model,
        api: parsed.api,
        promptVersion: PROMPT_VERSION,
        toolSchemaVersion: TOOL_SCHEMA_VERSION,
        reviewSchemaVersion: REVIEW_SCHEMA_VERSION,
        timeoutCohort: parsed.timeoutCohort,
    };
    const agentDir = getAgentDir();
    const error = appendPromotionRecord({
        agentDir,
        record: {
            kind: parsed.kind,
            candidateIdentity: identity,
            recordedAt: new Date().toISOString(),
            basis: parsed.basis,
        },
    });
    if (error !== null) {
        process.stderr.write(`${error}\n`);
        return 1;
    }
    process.stdout.write(
        `appended ${parsed.kind} record to ${promotionRecordsPath(agentDir)}\n` +
            `identity: ${JSON.stringify(identity)}\n` +
            `note: records load at session start; restart sessions to pick this up\n`,
    );
    return 0;
}

process.exit(main());
