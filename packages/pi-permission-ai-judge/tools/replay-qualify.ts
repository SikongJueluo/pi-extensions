/**
 * PIEXTENSIO-24 qualification logic behind `corpus-replay --strict`.
 *
 * The light qualification standard (ADR 0008 post-promotion era): a full
 * corpus replay where every case matches, no row is an infrastructure
 * failure, and every judgment's latency stays within the run's timeout
 * budget. This is owner-observed *compatibility* data for the advisory
 * model catalog — never a safety certification, and never a runtime
 * Enforce gate.
 *
 * Pure functions only: the harness feeds it rows and turns the result
 * into an exit code, so the standard itself stays testable offline.
 */

/** One replay row as emitted by the corpus-replay harness. The
 * harness-reported `match` is report data only — qualification recomputes
 * agreement from `expected`/`verdict` so contradictory rows cannot
 * qualify. */
export type ReplayRow = {
    readonly case: string;
    readonly expected: string;
    readonly verdict: string | null;
    readonly match: boolean;
    readonly latencyMs: number | null;
    readonly resultKind?: string;
};

export interface ReplayQualification {
    /** True only when every light-standard check passes. */
    readonly qualified: boolean;
    /** Human-readable failure reasons (empty when qualified). */
    readonly reasons: readonly string[];
    readonly totalCases: number;
    readonly matched: number;
    /** Case ids whose verdict differed from the expected one. */
    readonly mismatches: readonly string[];
    /** Case ids that returned an infrastructure failure instead of a verdict. */
    readonly infrastructureFailures: readonly string[];
    /** Latency percentiles over judgment rows; null when none measured. */
    readonly latencyMs: {
        readonly p50: number | null;
        readonly p95: number | null;
        readonly max: number | null;
    };
}

export interface QualifyOptions {
    /** Latency budget in ms; a judgment slower than this disqualifies. */
    readonly budgetMs: number;
}

function percentile(sorted: readonly number[], rank: number): number | null {
    if (sorted.length === 0) {
        return null;
    }
    const index = Math.min(sorted.length - 1, Math.floor(rank * (sorted.length - 1)));
    return sorted[index] as number;
}

function usableLatency(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Apply the light qualification standard to a completed replay's rows. */
export function qualifyReplay(
    rows: readonly ReplayRow[],
    options: QualifyOptions,
): ReplayQualification {
    const reasons: string[] = [];
    if (rows.length === 0) {
        reasons.push("no rows: qualification requires a full corpus replay");
    }

    const judgments = rows.filter((row) => row.verdict !== null);
    const mismatches = judgments
        .filter((row) => row.verdict !== row.expected)
        .map((row) => row.case);
    if (mismatches.length > 0) {
        reasons.push(`verdict mismatch: ${mismatches.join(", ")}`);
    }

    const infrastructureFailures = rows
        .filter((row) => row.verdict === null)
        .map((row) => row.case);
    if (infrastructureFailures.length > 0) {
        reasons.push(
            `infrastructure failure: ${infrastructureFailures.join(", ")}`,
        );
    }

    // A judgment row without a usable latency is unqualifiable: the
    // catalog's latency summary must be measured data, never assumed.
    const missingLatency = judgments.filter((row) => !usableLatency(row.latencyMs));
    if (missingLatency.length > 0) {
        reasons.push(
            `judgment without usable latency: ${missingLatency
                .map((row) => row.case)
                .join(", ")}`,
        );
    }

    const latencies = judgments
        .map((row) => row.latencyMs)
        .filter(usableLatency)
        .sort((a, b) => a - b);
    const overBudget = judgments.filter(
        (row) => usableLatency(row.latencyMs) && row.latencyMs > options.budgetMs,
    );
    if (overBudget.length > 0) {
        reasons.push(
            `latency beyond ${options.budgetMs}ms budget: ${overBudget
                .map((row) => `${row.case} (${row.latencyMs}ms)`)
                .join(", ")}`,
        );
    }

    const matched = judgments.filter((row) => row.verdict === row.expected).length;
    return Object.freeze({
        qualified: reasons.length === 0,
        reasons: Object.freeze(reasons),
        totalCases: rows.length,
        matched,
        mismatches: Object.freeze(mismatches),
        infrastructureFailures: Object.freeze(infrastructureFailures),
        latencyMs: Object.freeze({
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            max: latencies.length > 0 ? (latencies.at(-1) as number) : null,
        }),
    });
}
