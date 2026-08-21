/**
 * Offline Shadow analyzer for the AI Bash Judge (diagnostic grade).
 *
 * Reconstructs the PIEXTENSIO-9 comparison join from the permission-system
 * review JSONL **without upstream changes**: enrollment is proxied by
 * `authorizer_chain_resolved` entries whose `links` contain the judge link
 * name (recorded before any link runs), and the human decision is proxied by
 * `permission_request.approved|denied` rows attributed by a link-decision
 * marker (PIEXTENSIO-9's dedicated `permission_request.human_decided` event
 * does not exist upstream).
 *
 * Attribution rule (reconstructed, diagnostic-grade only):
 * a terminal `approved_for_session`/`approved_for_serving_session` outcome is
 * always human; a plain `approved`/`denied` outcome is a link decision when
 * the same requestId carries a decisive link marker (`inner_cmd.allow|deny`),
 * otherwise a human decision. Rows that fail this reconstruction — forwarded
 * roots, non-bash surfaces, ambiguous state transitions — are quarantined
 * with an explicit category, never silently dropped.
 */

/** Event kinds the analyzer consumes from the review JSONL. */
export interface ReviewEvent {
    readonly event: string;
    readonly requestId?: unknown;
    readonly links?: unknown;
    readonly resolution?: unknown;
    readonly denialReason?: unknown;
    readonly resultKind?: unknown;
    readonly verdict?: unknown;
    readonly code?: unknown;
    readonly modelCalled?: unknown;
    readonly judgeRuntimeId?: unknown;
    readonly provider?: unknown;
    readonly model?: unknown;
    readonly origin?: unknown;
    readonly judgeLatencyMs?: unknown;
    readonly modelLatencyMs?: unknown;
    readonly inputUsage?: unknown;
    readonly outputUsage?: unknown;
    readonly reasonLength?: unknown;
    readonly timestamp?: unknown;
}

/** Normalized outcome of one enrolled request, or a quarantine category. */
export type Disposition =
    | { readonly kind: "joined"; readonly row: JoinedRow }
    | { readonly kind: "quarantined"; readonly category: QuarantineCategory };

export type QuarantineCategory =
    | "duplicate_result"
    | "result_without_enrollment"
    | "human_before_result"
    | "multiple_human_decisions"
    | "terminal_event_unreadable"
    | "non_bash_surface";

/** Human decision extracted from the terminal permission_request event. */
export interface HumanDecision {
    readonly decision: "allow" | "deny";
    readonly state: string;
    readonly denialReason?: string | null;
}

export interface JoinedRow {
    readonly requestId: string;
    readonly judgeRuntimeId: string | null;
    readonly resultKind: "judgment" | "preflight_defer" | "infrastructure_failure";
    readonly verdict: "allow" | "deny" | "defer" | null;
    readonly code: string | null;
    readonly modelCalled: boolean;
    readonly provider: string | null;
    readonly model: string | null;
    readonly origin: string | null;
    readonly judgeLatencyMs: number | null;
    readonly modelLatencyMs: number | null;
    readonly inputUsage: number | null;
    readonly outputUsage: number | null;
    readonly reasonLength: number | null;
    readonly human: HumanDecision;
    readonly humanAttribution: "session_state" | "no_link_marker" | "unproven";
}

export interface AnalyzeResult {
    /** Unique enrollments (N) and every disposition in first-seen order. */
    readonly enrollments: number;
    readonly dispositions: readonly Disposition[];
    readonly metrics: Metrics;
}

export interface Metrics {
    readonly joined: number;
    readonly quarantined: Record<string, number>;
    readonly joinedJudgments: number;
    readonly completionCoverage: number;
    readonly humanJoinCoverage: number;
    readonly judgmentCoverage: number;
    /** comparison matrix [ai][human] over joined judgment rows */
    readonly matrix: Readonly<Record<string, number>>;
    readonly falseAllows: number;
    readonly falseAllowRate: number | null;
    readonly conservativeDeny: number;
    readonly conservativeDefer: number;
    readonly conservativeRate: number | null;
    readonly preflightDefers: number;
    readonly infrastructureFailures: number;
    readonly infrastructureByCode: Readonly<Record<string, number>>;
    readonly judgeLatency: LatencyStats | null;
    readonly modelLatency: LatencyStats | null;
}

export interface LatencyStats {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
    readonly missing: number;
}

const TERMINAL_STATES = new Set([
    "approved",
    "approved_for_session",
    "approved_for_serving_session",
    "denied",
    "confirmation_unavailable",
]);

const LINK_DECISION_MARKERS = new Set(["inner_cmd.allow", "inner_cmd.deny"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function percentile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    const index = Math.min(
        sorted.length - 1,
        Math.ceil((p / 100) * sorted.length) - 1,
    );
    return sorted[index] as number;
}

function latencyStats(values: readonly (number | null | undefined)[]): LatencyStats | null {
    const present = values
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
    if (values.length === 0) {
        return null;
    }
    return {
        p50: percentile(present, 50),
        p95: percentile(present, 95),
        max: present.length > 0 ? (present[present.length - 1] as number) : 0,
        missing: values.length - present.length,
    };
}

function humanFromResolution(
    resolution: string,
    denialReason: unknown,
): HumanDecision | { readonly error: "terminal_event_unreadable" } {
    const reason = asString(denialReason);
    switch (resolution) {
        case "approved":
        case "approved_for_session":
        case "approved_for_serving_session":
            return { decision: "allow", state: resolution, denialReason: reason };
        case "denied":
        // Upstream's provide-reason deny writes `denied_with_reason`.
        case "denied_with_reason":
            return { decision: "deny", state: resolution, denialReason: reason };
        default:
            return { error: "terminal_event_unreadable" };
    }
}

/**
 * Phase 1: collect per-requestId first-seen records in append order.
 */
interface CollectedEvents {
    readonly enrolled: ReadonlySet<string>;
    readonly results: ReadonlyMap<string, ReviewEvent[]>;
    readonly terminal: ReadonlyMap<string, ReviewEvent[]>;
    readonly linkMarkers: ReadonlySet<string>;
}

function collectReviewEvents(events: readonly ReviewEvent[]): CollectedEvents {
    const enrolled = new Set<string>();
    const results = new Map<string, ReviewEvent[]>();
    const terminal = new Map<string, ReviewEvent[]>();
    const linkMarkers = new Set<string>();

    for (const evt of events) {
        const requestId = asString(evt.requestId);
        if (requestId === null) {
            continue;
        }
        switch (evt.event) {
            case "authorizer_chain_resolved": {
                const links = Array.isArray(evt.links) ? evt.links : [];
                if (links.some((name) => name === "ai-bash-judge")) {
                    enrolled.add(requestId);
                }
                break;
            }
            case "ai_bash_judge.result":
                if (!results.has(requestId)) {
                    results.set(requestId, []);
                }
                (results.get(requestId) as ReviewEvent[]).push(evt);
                break;
            case "inner_cmd.allow":
            case "inner_cmd.deny":
                linkMarkers.add(requestId);
                break;
            case "permission_request.approved":
            case "permission_request.denied": {
                if (!terminal.has(requestId)) {
                    terminal.set(requestId, []);
                }
                (terminal.get(requestId) as ReviewEvent[]).push(evt);
                break;
            }
            default:
                break;
        }
    }
    return { enrolled, results, terminal, linkMarkers };
}

/** Outcome of joining one terminal request against its judge result. */
type JoinOutcome =
    | { readonly kind: "joined"; readonly row: JoinedRow }
    | { readonly kind: "quarantined"; readonly category: QuarantineCategory }
    | { readonly kind: "skipped" };

/**
 * Phase 2: join one enrolled request's terminal permission event against
 * its judge result. Guards run in append-order integrity order; the first
 * failure quarantines with an explicit category.
 */
function joinTerminalRequest(
    requestId: string,
    events: readonly ReviewEvent[],
    collected: CollectedEvents,
): JoinOutcome {
    const resultList = collected.results.get(requestId) ?? [];
    const terminalList = collected.terminal.get(requestId) ?? [];

    if (resultList.length > 1) {
        return { kind: "quarantined", category: "duplicate_result" };
    }
    const result = resultList[0];
    if (result === undefined) {
        // No result yet (or a lost write): counted as a coverage gap in
        // the metrics, not quarantined as an integrity fault.
        return { kind: "skipped" };
    }
    // The terminal permission_request entry must appear after the judge
    // result in append order. The terminal list is collected from the
    // same stream, so compare first-seen indices.
    const resultIndex = events.indexOf(result);
    const terminalEvents = terminalList.filter(
        (t) => events.indexOf(t) > resultIndex,
    );
    if (terminalEvents.length === 0) {
        return { kind: "quarantined", category: "human_before_result" };
    }
    if (terminalEvents.length > 1) {
        // Upstream's forwarded decision path double-writes the terminal
        // event with the same requestId and resolution in adjacent file
        // order (round 1: two `approved` or two `denied_with_reason`
        // rows in the same second). Identical-resolution duplicates are
        // that pattern, not an integrity fault: collapse to the first
        // row. Conflicting resolutions stay quarantined — the analyzer
        // must never pick a convenient outcome among alternatives
        // (PIEXTENSIO-9).
        const distinct = new Set(
            terminalEvents.map((t) => asString(t.resolution) ?? ""),
        );
        if (distinct.size > 1) {
            return { kind: "quarantined", category: "multiple_human_decisions" };
        }
    }
    const terminalEvent = terminalEvents[0] as ReviewEvent;
    const human = humanFromResolution(
        asString(terminalEvent.resolution) ?? "",
        terminalEvent.denialReason,
    );
    if ("error" in human) {
        return { kind: "quarantined", category: "terminal_event_unreadable" };
    }

    return {
        kind: "joined",
        row: buildJoinedRow(requestId, result, human, collected.linkMarkers),
    };
}

function buildJoinedRow(
    requestId: string,
    result: ReviewEvent,
    human: HumanDecision,
    linkMarkers: ReadonlySet<string>,
): JoinedRow {
    const state = human.state;
    let attribution: JoinedRow["humanAttribution"];
    if (
        state === "approved_for_session" ||
        state === "approved_for_serving_session"
    ) {
        attribution = "session_state";
    } else if (linkMarkers.has(requestId)) {
        attribution = "unproven";
    } else {
        attribution = "no_link_marker";
    }
    // `unproven` rows (a plain `approved` sharing the request with a link
    // allow) cannot be attributed to the human under the reconstructed
    // rule; they stay joined but never enter the comparison matrix.

    return {
        requestId,
        judgeRuntimeId: asString(result.judgeRuntimeId),
        resultKind:
            result.resultKind === "judgment" ||
                result.resultKind === "preflight_defer" ||
                result.resultKind === "infrastructure_failure"
                ? result.resultKind
                : "infrastructure_failure",
        verdict:
            result.verdict === "allow" ||
                result.verdict === "deny" ||
                result.verdict === "defer"
                ? result.verdict
                : null,
        code: asString(result.code),
        modelCalled: asBoolean(result.modelCalled) ?? false,
        provider: asString(result.provider),
        model: asString(result.model),
        origin: asString(result.origin),
        judgeLatencyMs: asOptionalNumber(result.judgeLatencyMs),
        modelLatencyMs: asOptionalNumber(result.modelLatencyMs),
        inputUsage: asOptionalNumber(result.inputUsage),
        outputUsage: asOptionalNumber(result.outputUsage),
        reasonLength: asOptionalNumber(result.reasonLength),
        human,
        humanAttribution: attribution,
    };
}

/**
 * Reconstruct the PIEXTENSIO-9 join over a review event stream.
 *
 * Input is the raw parsed JSONL of one permission review log. File order is
 * authoritative: a human decision must appear after the judge result in
 * append order. Enrollments with no result remain visible in
 * `metrics.completionCoverage` and their dispositions are omitted from the
 * joined set without a quarantine entry (missing outcomes are counted, not
 * invented).
 */
export function analyzeShadowReviewLog(events: readonly ReviewEvent[]): AnalyzeResult {
    const collected = collectReviewEvents(events);

    const dispositions: Disposition[] = [];
    const joined: JoinedRow[] = [];
    const quarantined: Record<string, number> = {};
    const quarantine = (category: QuarantineCategory): void => {
        quarantined[category] = (quarantined[category] ?? 0) + 1;
        dispositions.push({ kind: "quarantined", category });
    };

    for (const requestId of collected.terminal.keys()) {
        if (!collected.enrolled.has(requestId)) {
            continue;
        }
        const outcome = joinTerminalRequest(requestId, events, collected);
        if (outcome.kind === "quarantined") {
            quarantine(outcome.category);
        } else if (outcome.kind === "joined") {
            joined.push(outcome.row);
            dispositions.push({ kind: "joined", row: outcome.row });
        }
    }

    // Results without enrollment are integrity faults: the denominator must
    // be permission-owned.
    const terminalIds = [...collected.terminal.keys()];
    for (const requestId of collected.results.keys()) {
        if (!collected.enrolled.has(requestId) && !terminalIds.includes(requestId)) {
            quarantine("result_without_enrollment");
        }
    }

    return {
        enrollments: collected.enrolled.size,
        dispositions,
        metrics: computeMetrics(collected.enrolled.size, joined, quarantined),
    };
}

/** Per-kind tallies collected in one pass over the joined rows. */
interface RowTallies {
    readonly joinedJudgments: number;
    readonly falseAllows: number;
    readonly conservativeDeny: number;
    readonly conservativeDefer: number;
    readonly humanAllowJudgments: number;
    readonly preflightDefers: number;
    readonly infrastructureFailures: number;
    readonly infraByCode: Record<string, number>;
    /** Comparison matrix [ai|human] over attributable judgment rows. */
    readonly matrix: Record<string, number>;
    readonly judgeLatencies: Array<number | null | undefined>;
    readonly modelLatencies: Array<number | null | undefined>;
}

/** Counters accumulated over attributable judgment rows. */
interface MatrixCounters {
    matrix: Record<string, number>;
    falseAllows: number;
    conservativeDeny: number;
    conservativeDefer: number;
    humanAllowJudgments: number;
}

/**
 * Tally one attributable judgment row into the comparison matrix and the
 * conservative-direction counters. Unattributable rows never reach here.
 */
function tallyAttributable(row: JoinedRow, c: MatrixCounters): void {
    const key = `${row.verdict ?? "null"}|${row.human.decision}`;
    c.matrix[key] = (c.matrix[key] ?? 0) + 1;
    if (row.human.decision === "allow") {
        c.humanAllowJudgments += 1;
    }
    if (row.verdict === "allow" && row.human.decision === "deny") {
        c.falseAllows += 1;
    }
    if (row.verdict === "deny" && row.human.decision === "allow") {
        c.conservativeDeny += 1;
    }
    if (row.verdict === "defer" && row.human.decision === "allow") {
        c.conservativeDefer += 1;
    }
}

/**
 * One pass over joined rows: latencies are collected for every row;
 * non-judgment rows (preflight/infra) are tallied and excluded; judgment
 * rows enter the comparison matrix unless their human attribution is
 * `unproven` (those stay joined but never enter the matrix).
 */
function tallyJoinedRows(joined: readonly JoinedRow[]): RowTallies {
    const infraByCode: Record<string, number> = {};
    const judgeLatencies: Array<number | null | undefined> = [];
    const modelLatencies: Array<number | null | undefined> = [];

    let joinedJudgments = 0;
    let preflightDefers = 0;
    let infrastructureFailures = 0;
    const counters: MatrixCounters = {
        matrix: {},
        falseAllows: 0,
        conservativeDeny: 0,
        conservativeDefer: 0,
        humanAllowJudgments: 0,
    };

    for (const row of joined) {
        judgeLatencies.push(row.judgeLatencyMs);
        modelLatencies.push(row.modelLatencyMs);
        switch (row.resultKind) {
            case "preflight_defer":
                preflightDefers += 1;
                continue;
            case "infrastructure_failure": {
                infrastructureFailures += 1;
                const code = row.code ?? "unknown";
                infraByCode[code] = (infraByCode[code] ?? 0) + 1;
                continue;
            }
            case "judgment":
                break;
        }
        joinedJudgments += 1;
        if (row.humanAttribution !== "unproven") {
            tallyAttributable(row, counters);
        }
    }

    return {
        joinedJudgments,
        falseAllows: counters.falseAllows,
        conservativeDeny: counters.conservativeDeny,
        conservativeDefer: counters.conservativeDefer,
        humanAllowJudgments: counters.humanAllowJudgments,
        preflightDefers,
        infrastructureFailures,
        infraByCode,
        matrix: counters.matrix,
        judgeLatencies,
        modelLatencies,
    };
}

function computeMetrics(
    n: number,
    joined: readonly JoinedRow[],
    quarantined: Record<string, number>,
): Metrics {
    const t = tallyJoinedRows(joined);
    return {
        joined: joined.length,
        quarantined,
        joinedJudgments: t.joinedJudgments,
        completionCoverage: joined.length / (n || 1),
        humanJoinCoverage: (joined.length - unprovenCount(joined)) / (n || 1),
        judgmentCoverage: t.joinedJudgments / (n || 1),
        matrix: t.matrix,
        falseAllows: t.falseAllows,
        falseAllowRate: t.falseAllows > 0 || hasAllowPrediction(t.matrix)
            ? t.falseAllows / allowPredictions(t.matrix)
            : null,
        conservativeDeny: t.conservativeDeny,
        conservativeDefer: t.conservativeDefer,
        conservativeRate:
            t.humanAllowJudgments > 0
                ? (t.conservativeDeny + t.conservativeDefer) / t.humanAllowJudgments
                : null,
        preflightDefers: t.preflightDefers,
        infrastructureFailures: t.infrastructureFailures,
        infrastructureByCode: t.infraByCode,
        judgeLatency: latencyStats(t.judgeLatencies),
        modelLatency: latencyStats(t.modelLatencies),
    };
}

// ── helper functions below exist to keep computeMetrics readable; they are
// not part of the public surface.

function unprovenCount(joined: readonly JoinedRow[]): number {
    // The human-join coverage counts joined rows with an
    // attributable human outcome; `unproven` rows are joined but
    // never attributable.
    return joined.filter((r) => r.humanAttribution === "unproven").length;
}

function allowPredictions(matrix: Readonly<Record<string, number>>): number {
    return (matrix["allow|allow"] ?? 0) + (matrix["allow|deny"] ?? 0);
}

function hasAllowPrediction(matrix: Readonly<Record<string, number>>): boolean {
    return allowPredictions(matrix) > 0;
}
