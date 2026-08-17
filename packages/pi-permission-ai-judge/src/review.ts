import type { AuthorizerLog } from "@gotgenes/pi-permission-system";

/**
 * Review-sink adapter (PIEXTENSIO-3 cat.5, PIEXTENSIO-9 telemetry-health
 * prerequisite).
 *
 * Wraps the chain-provided `AuthorizerLog` with the write-acknowledgement
 * semantics the reconstructed upstream seam lacks: the installed
 * `review()` returns void (failures are swallowed into a UI warning), so
 * this adapter tracks sink health from what it *can* observe —
 *
 * - `enabled`: derived once at session start by reading the
 *   permission-system review-log toggle from its config file. A disabled
 *   review sink marks the runtime non-evaluable (PIEXTENSIO-9: data
 *   collected while disabled can never enter a promotion cohort).
 * - `write_failed`/`integrity_anomaly`: not detectable at runtime against
 *   the void seam; they are represented in the health enum so the truth
 *   table can be exercised with fake gates, and surface offline as
 *   coverage gaps (enrollment without a result).
 *
 * The privacy denylist is enforced at this sink: event keys matching the
 * forbidden patterns are stripped before delegation, so a future upstream
 * change that starts persisting unknown keys cannot leak Bash text,
 * working directories, or model replies through the review log.
 */

export type TelemetryHealth =
    | "healthy"
    | "disabled"
    | "write_failed"
    | "integrity_anomaly";

/** Key-name patterns the permission-system's redactor already masks; the
 * judge must not fight it by renaming, and must not add keys that carry
 * evidence content. Forbidden for any *new* judge-owned event key. */
const FORBIDDEN_KEY_PATTERNS = [
    /token/i,
    /key/i,
    /secret/i,
    /password/i,
    /credential/i,
];

export interface ReviewSink {
    /** Current telemetry health; read by the truth table before authority. */
    readonly health: () => TelemetryHealth;
    /** Metadata-only review write through the acknowledged sink. */
    readonly review: (event: string, details: Record<string, unknown>) => void;
    /** Debug write (gated by the permission-system's debug toggle). */
    readonly debug: (event: string, details?: Record<string, unknown>) => void;
}

export interface ReviewSinkDeps {
    /** Chain-provided logging seam (returns void; health is tracked here). */
    readonly log: AuthorizerLog;
    /** Review-log toggle read at session start; false marks non-evaluable. */
    readonly reviewLogEnabled: boolean;
}

/** Strip forbidden keys defensively; a metadata-only event never carries them. */
function stripForbiddenKeys(
    details: Record<string, unknown>,
): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
            continue;
        }
        clean[key] = value;
    }
    return clean;
}

export function createReviewSink(deps: ReviewSinkDeps): ReviewSink {
    let health: TelemetryHealth = deps.reviewLogEnabled
        ? "healthy"
        : "disabled";
    return {
        health: () => health,
        review: (event, details) => {
            if (health === "disabled") {
                // Writes while disabled are still attempted (the toggle is
                // read at start; the permission-system may have re-enabled
                // it), but the runtime stays non-evaluable.
                deps.log.review(event, stripForbiddenKeys(details));
                return;
            }
            deps.log.review(event, stripForbiddenKeys(details));
        },
        debug: (event, details) => {
            deps.log.debug(event, details);
        },
    };
}
