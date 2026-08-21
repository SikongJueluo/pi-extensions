#!/usr/bin/env node
/**
 * Offline Shadow analyzer CLI (diagnostic grade).
 *
 * Reads the permission-system review JSONL and prints the PIEXTENSIO-9
 * metrics computed over the reconstructed requestId join. Output is
 * metadata-only: no command text from the source log is echoed.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { analyzeShadowReviewLog, type ReviewEvent } from "./analyze";

const USAGE = `usage: analyze-shadow <review-jsonl-path> [options]

options:
  --after <iso8601>   only consider events with timestamp >= this instant
  --before <iso8601>  only consider events with timestamp <= this instant
  --audit <path>      Judge-owned audit JSONL (ADR 0006); enrollment (the
                      denominator N) is then taken from its
                      ai_bash_judge.enrolled rows instead of the reconstructed
                      permission-system chain events
  --help              show this help

The report is diagnostic-grade: the join reconstructs enrollment and human
decisions from permission-system events (no upstream changes), so coverage
and matrix numbers must not be used as promotion-grade evidence.`;

interface CliOptions {
    readonly path: string;
    readonly after: Date | null;
    readonly before: Date | null;
    readonly audit: string | null;
}

/** Parse one `--after`/`--before` timestamp value; error string on failure. */
export function parseTimestampOption(
    arg: string,
    value: string | undefined,
): { date: Date } | { error: string } {
    if (value === undefined) {
        return { error: `${arg} requires a value` };
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return { error: `invalid ${arg} timestamp: ${value}` };
    }
    return { date };
}

/** Parse CLI options; exported for in-process tests. */
export function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
    const args = argv.slice(2);
    let path: string | undefined;
    let after: Date | null = null;
    let before: Date | null = null;
    let audit: string | null = null;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] as string;
        if (arg === "--help" || arg === "-h") {
            return { error: USAGE };
        }
        if (arg === "--audit") {
            const value = args[i + 1];
            if (value === undefined) {
                return { error: `${arg} requires a value` };
            }
            audit = value;
            i += 1;
            continue;
        }
        if (arg === "--after" || arg === "--before") {
            const parsed = parseTimestampOption(arg, args[i + 1]);
            if ("error" in parsed) {
                return parsed;
            }
            if (arg === "--after") {
                after = parsed.date;
            } else {
                before = parsed.date;
            }
            i += 1;
            continue;
        }
        if (arg.startsWith("--")) {
            return { error: `unknown option: ${arg}` };
        }
        if (path !== undefined) {
            return { error: "multiple input paths given" };
        }
        path = arg;
    }
    if (path === undefined) {
        return { error: "missing input path" };
    }
    return { path, after, before, audit };
}

function parseLine(line: string, lineNo: number): ReviewEvent | null {
    if (line.trim().length === 0) {
        return null;
    }
    try {
        return JSON.parse(line) as ReviewEvent;
    } catch {
        process.stderr.write(
            `warning: skipping unparseable line ${lineNo}\n`,
        );
        return null;
    }
}

function fmtRate(value: number | null): string {
    if (value === null) {
        return "N/A";
    }
    return `${(value * 100).toFixed(1)}%`;
}

function fmtLatency(stats: {
    p50: number;
    p95: number;
    max: number;
    missing: number;
} | null): string {
    if (stats === null) {
        return "N/A";
    }
    return `p50=${stats.p50}ms p95=${stats.p95}ms max=${stats.max}ms missing=${stats.missing}`;
}

/** Parse one review-log JSONL file, skipping blank/unparseable lines. */
function loadReviewEvents(path: string): ReviewEvent[] {
    let raw: string;
    try {
        raw = readFileSync(path, "utf-8");
    } catch (error) {
        process.stderr.write(
            `error: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
    }
    return raw
        .split("\n")
        .map((line, index) => parseLine(line, index + 1))
        .filter((evt): evt is ReviewEvent => evt !== null);
}

/** The `--after`/`--before` selection window; exported for tests. */
export interface TimeWindow {
    readonly after: Date | null;
    readonly before: Date | null;
}

/** True when an event's timestamp falls inside the window (or is absent). */
export function withinWindow(evt: ReviewEvent, window: TimeWindow): boolean {
    const ts = typeof evt.timestamp === "string" ? evt.timestamp : null;
    if (ts === null) {
        return true;
    }
    const time = new Date(ts).getTime();
    if (window.after !== null && !Number.isNaN(time) && time < window.after.getTime()) {
        return false;
    }
    if (window.before !== null && !Number.isNaN(time) && time > window.before.getTime()) {
        return false;
    }
    return true;
}

/**
 * ADR 0006 dual-log mode: with --audit, the denominator comes from the
 * Judge's own enrolled rows (asks it received), rewritten as synthetic
 * enrollment events so the reconstructed permission-system enrollment
 * proxy can be dropped to avoid a second denominator source. Human
 * decisions still come from the permission log (attribution join).
 */
function loadAuditEnrolled(auditPath: string, window: TimeWindow): ReviewEvent[] {
    return loadReviewEvents(auditPath)
        .filter((evt) => evt.event === "ai_bash_judge.enrolled")
        .filter((evt) => withinWindow(evt, window))
        .map((evt) => ({
            ...evt,
            event: "authorizer_chain_resolved",
            links: ["ai-bash-judge"],
        }) as ReviewEvent);
}

function main(): void {
    const parsed = parseArgs(process.argv);
    if ("error" in parsed) {
        process.stderr.write(`${parsed.error}\n`);
        process.exit(parsed.error === USAGE ? 0 : 1);
    }

    const window: TimeWindow = { after: parsed.after, before: parsed.before };
    const events = loadReviewEvents(parsed.path).filter((evt) =>
        withinWindow(evt, window),
    );
    let joined = events;
    if (parsed.audit !== null) {
        const auditEnrolled = loadAuditEnrolled(parsed.audit, window);
        joined = [
            ...events.filter((evt) => evt.event !== "authorizer_chain_resolved"),
            ...auditEnrolled,
        ];
    }

    const { enrollments, metrics } = analyzeShadowReviewLog(joined);
    printReport(parsed, enrollments, metrics);
}

export function printReport(
    parsed: CliOptions,
    enrollments: number,
    metrics: ReturnType<typeof analyzeShadowReviewLog>["metrics"],
): void {
    const out = process.stdout;

    out.write("AI Bash Judge — Shadow diagnostic report\n");
    out.write("grade: DIAGNOSTIC (reconstructed join; not promotion-grade)\n");
    out.write(`asOf: ${new Date().toISOString()}\n`);
    out.write(`source: ${parsed.path}\n`);
    if (parsed.audit !== null) {
        out.write(`audit: ${parsed.audit} (enrollment source, ADR 0006)\n`);
    }
    out.write("\n");

    out.write(`enrollments (N): ${enrollments}\n`);
    out.write(`joined rows: ${metrics.joined}\n`);
    out.write(`joined judgments: ${metrics.joinedJudgments}\n\n`);

    out.write(`completion coverage: ${fmtRate(metrics.completionCoverage)}\n`);
    out.write(`human-join coverage: ${fmtRate(metrics.humanJoinCoverage)}\n`);
    out.write(`judgment coverage: ${fmtRate(metrics.judgmentCoverage)}\n\n`);

    const quarantineEntries = Object.entries(metrics.quarantined).sort(
        ([a], [b]) => a.localeCompare(b),
    );
    if (quarantineEntries.length > 0) {
        out.write("quarantined rows:\n");
        for (const [category, count] of quarantineEntries) {
            out.write(`  ${category}: ${count}\n`);
        }
        out.write("\n");
    }

    out.write("comparison matrix [verdict|human]:\n");
    const keys = Object.keys(metrics.matrix).sort();
    if (keys.length === 0) {
        out.write("  (empty)\n");
    }
    for (const key of keys) {
        out.write(`  ${key}: ${metrics.matrix[key]}\n`);
    }
    out.write("\n");

    out.write(`false allows: ${metrics.falseAllows}`);
    out.write(` (rate ${fmtRate(metrics.falseAllowRate)})\n`);
    out.write(
        `conservative: deny ${metrics.conservativeDeny}, defer ${metrics.conservativeDefer} (rate ${fmtRate(metrics.conservativeRate)})\n\n`,
    );

    out.write(`preflight defers: ${metrics.preflightDefers}\n`);
    out.write(`infrastructure failures: ${metrics.infrastructureFailures}\n`);
    const codes = Object.keys(metrics.infrastructureByCode).sort();
    for (const code of codes) {
        out.write(`  ${code}: ${metrics.infrastructureByCode[code]}\n`);
    }
    out.write("\n");

    out.write(`judge latency: ${fmtLatency(metrics.judgeLatency)}\n`);
    out.write(`model latency: ${fmtLatency(metrics.modelLatency)}\n`);
}

// Run as a script only (not under vitest imports): same guard as
// tools/corpus-replay.ts.
if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main();
}
