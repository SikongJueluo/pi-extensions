import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
    type PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { buildBashJudgmentEvidence } from "./evidence";
import {
    createModelAvailability,
    requestStructuredVerdict,
    type ModelAvailability,
} from "./model";
import { PROMPT_VERSION, TOOL_SCHEMA_VERSION } from "./prompt";

const LINK_NAME = "ai-bash-judge";
const REVIEW_SCHEMA_VERSION = 1;

interface RootSession {
    readonly getSessionId: () => string;
    readonly expectedSessionId: string;
    readonly model: ModelAvailability;
    readonly shutdown: AbortController;
    /** Opaque per-runtime identity for cohort segmentation. */
    readonly judgeRuntimeId: string;
}

function reasonLength(reason: string): number {
    return [...reason].length;
}

/**
 * Evidence-quality flags without evidence content (PIEXTENSIO-9).
 *
 * This bootstrap slice sends command-only input: no conversation, no cwd,
 * no explicit user text (see docs/research/ai-bash-judge-input-minimality).
 * `false` marks a definitively absent field; `null` marks one this slice
 * does not capture, so the analyzer never mistakes absence for zero.
 */
function evidenceQuality(
    structuredFullInput: boolean,
    forwardedProvenance: boolean | null = null,
): Record<string, unknown> {
    return {
        structuredFullInput,
        legacyMessage: false,
        requesterCwd: null,
        explicitUserText: false,
        forwardedProvenance,
        conversationItems: null,
        conversationChars: null,
        truncated: false,
        latestUserPreserved: null,
    };
}

/**
 * Identity, cohort, and reproducibility fields shared by every result kind.
 * End-to-end latency is measured from authorize entry to this call.
 */
function resultBase(
    judgeRuntimeId: string,
    details: PromptPermissionDetails,
    startedAt: number,
): Record<string, unknown> {
    return {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        requestId: details.requestId,
        judgeRuntimeId,
        mode: "shadow",
        origin:
            details.forwarding !== undefined ||
                details.payload.kind === "forwarded"
                ? "forwarded"
                : "local",
        promptVersion: PROMPT_VERSION,
        toolSchemaVersion: TOOL_SCHEMA_VERSION,
        judgeLatencyMs: Date.now() - startedAt,
    };
}

/** Register a Shadow-only structured-output judge for local native Bash asks. */
export default function permissionAiJudge(pi: ExtensionAPI): void {
    let root: RootSession | undefined;
    let disposeAuthorizer: (() => void) | undefined;

    function tryRegister(): void {
        if (disposeAuthorizer !== undefined || root === undefined) {
            return;
        }

        const service = getPermissionsService();
        if (service === undefined) {
            return;
        }

        const captured = root;
        disposeAuthorizer = service.registerAuthorizer(
            LINK_NAME,
            async (details, _query, log) => {
                const startedAt = Date.now();
                try {
                    // Forwarded asks do not carry a structured child full
                    // command in permission-system 25.3/25.4. Never parse the
                    // legacy prose. The deferral is recorded so the request
                    // stays visible in the offline denominator instead of
                    // silently vanishing.
                    if (
                        details.forwarding !== undefined ||
                        details.payload.kind === "forwarded"
                    ) {
                        log.review("ai_bash_judge.result", {
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                            ),
                            resultKind: "preflight_defer",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: false,
                            code: "missing_structured_input",
                            evidenceQuality: evidenceQuality(false, false),
                        });
                        return { kind: "defer" };
                    }

                    // Ignore unrelated permission surfaces without producing a
                    // Shadow row or invoking the model: the v0.1 cohort selects
                    // accessSurface = bash only.
                    if (details.payload.kind !== "bash") {
                        return { kind: "defer" };
                    }

                    if (
                        captured.getSessionId() !== captured.expectedSessionId
                    ) {
                        log.review("ai_bash_judge.result", {
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                            ),
                            resultKind: "preflight_defer",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: false,
                            code: "session_ownership_unproven",
                            evidenceQuality: evidenceQuality(false),
                        });
                        return { kind: "defer" };
                    }

                    const evidence = buildBashJudgmentEvidence(details);
                    if (evidence === undefined) {
                        log.review("ai_bash_judge.result", {
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                            ),
                            resultKind: "preflight_defer",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: false,
                            code: "invalid_evidence",
                            evidenceQuality: evidenceQuality(false),
                        });
                        return { kind: "defer" };
                    }

                    // `captured.model` is the session-start snapshot. Config and
                    // model-select support are deliberately outside this slice.
                    const result = await requestStructuredVerdict(
                        captured.model,
                        evidence,
                        captured.shutdown.signal,
                    );

                    if (result.kind === "judgment") {
                        log.review("ai_bash_judge.result", {
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                            ),
                            resultKind: "judgment",
                            verdict: result.verdict,
                            effectiveVerdict: "defer",
                            modelCalled: true,
                            code: null,
                            provider: result.metadata.provider,
                            model: result.metadata.model,
                            api: result.metadata.api,
                            // Log keys deliberately avoid the substring
                            // "token": permission-system masks any key matching
                            // /token/i (structural key-name redaction), which
                            // would erase usage telemetry from the review log.
                            inputUsage: result.inputTokens,
                            outputUsage: result.outputTokens,
                            modelLatencyMs: result.modelLatencyMs,
                            reasonLength: reasonLength(result.reason),
                            evidenceQuality: evidenceQuality(true),
                        });
                    } else {
                        log.review("ai_bash_judge.result", {
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                            ),
                            resultKind: "infrastructure_failure",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: result.modelCalled,
                            code: result.code,
                            provider: result.metadata?.provider ?? null,
                            model: result.metadata?.model ?? null,
                            api: result.metadata?.api ?? null,
                            inputUsage: result.inputTokens ?? null,
                            outputUsage: result.outputTokens ?? null,
                            modelLatencyMs: result.modelLatencyMs,
                            evidenceQuality: evidenceQuality(true),
                        });
                    }

                    // Bootstrap behavior is Shadow-only: the parsed prediction
                    // is recorded but never changes permission authority.
                    return { kind: "defer" };
                } catch {
                    // A link exception would abort the whole authority chain.
                    // Keep provider/payload/session failures fail-closed and do
                    // not include raw errors or authorization evidence in logs.
                    log.debug("ai_bash_judge.exception");
                    return { kind: "defer" };
                }
            },
        );
    }

    pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI) {
            return;
        }

        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId) {
            return;
        }

        root = {
            getSessionId: () => ctx.sessionManager.getSessionId(),
            expectedSessionId: sessionId,
            model: createModelAvailability(ctx.model, ctx.modelRegistry),
            shutdown: new AbortController(),
            judgeRuntimeId: crypto.randomUUID(),
        };
        tryRegister();
    });

    pi.events.on(PERMISSIONS_READY_CHANNEL, tryRegister);

    pi.on("session_shutdown", () => {
        root?.shutdown.abort();
        disposeAuthorizer?.();
        disposeAuthorizer = undefined;
        root = undefined;
    });
}
