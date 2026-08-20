import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
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
import { loadJudgeConfig, type EffectiveJudgeConfig } from "./config";
import { createReviewSink, type ReviewSink } from "./review";
import { createAuditLog, type AuditLog } from "./audit";
import {
    buildConversationEvidence,
    conversationProbeFromSession,
    type ConversationEvidence,
} from "./conversation";
import {
    evaluateEnforceAuthority,
    type EnforceGateState,
} from "./judge";
import {
    loadPromotionRecords,
    resolvePromotionGates,
    type CandidateIdentity,
    type PromotionRecordsSnapshot,
} from "./promotion";

const LINK_NAME = "ai-bash-judge";
const REVIEW_SCHEMA_VERSION = 1;

interface RootSession {
    readonly getSessionId: () => string;
    readonly expectedSessionId: string;
    /** Current-model probe: reads the live model at each authorize call. */
    readonly getModel: () => Model<any> | undefined;
    readonly modelRegistry: ModelRegistry;
    readonly shutdown: AbortController;
    /** Opaque per-runtime identity for cohort segmentation. */
    readonly judgeRuntimeId: string;
    /** Immutable effective-config snapshot captured at session start
     * (reload-only application: a config edit lands on the next session). */
    readonly config: EffectiveJudgeConfig;
    /** Review-log toggle captured at session start (PIEXTENSIO-9 health). */
    readonly reviewLogEnabled: boolean;
    /** Serving-session conversation seam (compaction-aware active branch). */
    readonly conversation: ReturnType<typeof conversationProbeFromSession>;
    /** Requesting-session cwd for relative-path meaning. */
    readonly getCwd: () => string;
    /** Judge-owned audit log (ADR 0006); unhealthy refuses Enforce authority. */
    readonly auditLog: AuditLog;
    /** Promotion-records snapshot loaded at session start (PIEXTENSIO-21);
     * gates are resolved per ask against the live candidate identity. */
    readonly promotionRecords: PromotionRecordsSnapshot;
    /** Static candidate-identity fields (everything except the model
     * segment, which is captured per ask). */
    readonly identityBase: Omit<
        CandidateIdentity,
        "provider" | "model" | "api"
    >;
}

const EMPTY_CONVERSATION: ConversationEvidence = {
    items: [],
    hasCompaction: false,
    truncated: false,
    renderedChars: 0,
};

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
    conversation: ConversationEvidence,
    requesterCwd: string,
    forwardedProvenance: boolean | null = null,
): Record<string, unknown> {
    return {
        structuredFullInput,
        legacyMessage: false,
        requesterCwd,
        explicitUserText: conversation.items.length > 0,
        forwardedProvenance,
        conversationItems: conversation.items.length,
        conversationChars: conversation.renderedChars,
        truncated: conversation.truncated,
        latestUserPreserved: conversation.items.length > 0,
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
    config: EffectiveJudgeConfig,
): Record<string, unknown> {
    return {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        requestId: details.requestId,
        judgeRuntimeId,
        mode: config.mode,
        // v0.1 fail-closed: `enforce` loads here but the truth table can
        // never grant real authority, so the effective verdict below stays
        // defer; the configured mode is recorded for audit.
        timeoutCohort: config.timeoutCohort,
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


/** Read the permission-system review-log toggle (default true when unset). */
function readPermissionReviewLogEnabled(): boolean {
    try {
        const configPath = join(
            getAgentDir(),
            "extensions",
            "pi-permission-system",
            "config.json",
        );
        const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
            string,
            unknown
        >;
        return parsed.permissionReviewLog !== false;
    } catch {
        return true;
    }
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
                const sink: ReviewSink = createReviewSink({
                    log,
                    reviewLogEnabled: captured.reviewLogEnabled,
                });
                try {
                    // Judge-owned enrollment record (ADR 0006 denominator:
                    // asks the Judge received, per its own audit log).
                    // Non-bash surfaces are ignored below without a shadow
                    // row; they also do not enroll (v0.1 cohort is bash-only).
                    if (
                        details.forwarding !== undefined ||
                        details.payload.kind === "forwarded" ||
                        details.payload.kind === "bash"
                    ) {
                        captured.auditLog.audit("ai_bash_judge.enrolled", {
                            requestId: details.requestId,
                            origin:
                                details.forwarding !== undefined ||
                                    details.payload.kind === "forwarded"
                                    ? "forwarded"
                                    : "local",
                            surface: "bash",
                            command:
                                details.payload.kind === "bash" &&
                                    details.payload.request?.value
                                    ? details.payload.request.value
                                    : (details.command ?? null),
                        });
                    }
                    const emitResult = (record: Record<string, unknown>): void => {
                        sink.review("ai_bash_judge.result", record);
                        captured.auditLog.audit("ai_bash_judge.result", record);
                    };
                    // Forwarded asks do not carry a structured child full
                    // command in permission-system 25.3/25.4. Never parse the
                    // legacy prose. The deferral is recorded so the request
                    // stays visible in the offline denominator instead of
                    // silently vanishing.
                    if (
                        details.forwarding !== undefined ||
                        details.payload.kind === "forwarded"
                    ) {
                        emitResult({
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                                captured.config,
                            ),
                            resultKind: "preflight_defer",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: false,
                            code: "missing_structured_input",
                            evidenceQuality: evidenceQuality(false, EMPTY_CONVERSATION, "", false),
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
                        emitResult({
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                                captured.config,
                            ),
                            resultKind: "preflight_defer",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: false,
                            code: "session_ownership_unproven",
                            evidenceQuality: evidenceQuality(false, EMPTY_CONVERSATION, ""),
                        });
                        return { kind: "defer" };
                    }

                    const evidence = buildBashJudgmentEvidence(details);
                    if (evidence === undefined) {
                        emitResult({
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                                captured.config,
                            ),
                            resultKind: "preflight_defer",
                            verdict: null,
                            effectiveVerdict: "defer",
                            modelCalled: false,
                            code: "invalid_evidence",
                            evidenceQuality: evidenceQuality(false, EMPTY_CONVERSATION, ""),
                        });
                        return { kind: "defer" };
                    }

                    // Per-request model capture (PIEXTENSIO-3 cat.3): an
                    // in-request switch does not change an in-flight attempt;
                    // a between-request switch affects the next attempt. The
                    // probe reads the live current model here, not at start.
                    const availability = createModelAvailability(
                        captured.getModel(),
                        captured.modelRegistry,
                    );
                    // Conversation evidence is captured at ask time from the
                    // live serving branch, not at session start: the newest
                    // user intent is the ask's intent.
                    const conversation: ConversationEvidence =
                        buildConversationEvidence(captured.conversation);
                    const result = await requestStructuredVerdict(
                        availability,
                        evidence,
                        captured.shutdown.signal,
                        captured.config.timeoutMs,
                        conversation,
                    );

                    // Enforce truth table (PIEXTENSIO-3 cat.4 / M5): the
                    // promotion gates resolve per ask from the session-start
                    // records snapshot against the live candidate identity
                    // (PIEXTENSIO-21) — the current model segment is part of
                    // that identity, so a mid-session model switch cannot
                    // inherit another segment's records, and identity drift
                    // after recording fails closed. The truth table is the
                    // single authority seam: the owner's records flip the
                    // gate inputs, never the callback's return path.
                    // reviewAcknowledged is true in the ADR 0006 sense: the
                    // Judge-owned audit write for this result happens before
                    // the authority return, and a failed write flips
                    // auditHealthy sticky-unhealthy, closing authority for
                    // every later ask.
                    const liveIdentity: CandidateIdentity = {
                        ...captured.identityBase,
                        provider: result.metadata?.provider ?? "",
                        model: result.metadata?.model ?? "",
                        api: result.metadata?.api ?? "",
                    };
                    const gates = resolvePromotionGates(
                        captured.promotionRecords,
                        liveIdentity,
                    );
                    const gateState: EnforceGateState = {
                        auditHealthy: captured.auditLog.healthy(),
                        telemetryHealth: sink.health(),
                        cohortQualified: gates.cohortQualified,
                        ownerApprovalRecorded: gates.ownerApprovalRecorded,
                        activationRecorded: gates.activationRecorded,
                        resultKind:
                            result.kind === "judgment"
                                ? "judgment"
                                : result.kind,
                        verdict:
                            result.kind === "judgment" ? result.verdict : null,
                        reviewAcknowledged: true,
                        generationCurrent: !captured.shutdown.signal.aborted,
                        mode: captured.config.mode,
                    };
                    const authority = evaluateEnforceAuthority(gateState);
                    const effectiveVerdict =
                        authority.kind === "allow" ? "allow" : "defer";
                    const authorityBlockedBy =
                        authority.kind === "allow" ? null : authority.blockedBy;

                    if (result.kind === "judgment") {
                        emitResult({
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                                captured.config,
                            ),
                            resultKind: "judgment",
                            verdict: result.verdict,
                            effectiveVerdict,
                            authorityBlockedBy,
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
                            evidenceQuality: evidenceQuality(true, conversation, captured.getCwd()),
                        });
                    } else {
                        emitResult({
                            ...resultBase(
                                captured.judgeRuntimeId,
                                details,
                                startedAt,
                                captured.config,
                            ),
                            resultKind: "infrastructure_failure",
                            verdict: null,
                            effectiveVerdict,
                            authorityBlockedBy,
                            modelCalled: result.modelCalled,
                            code: result.code,
                            provider: result.metadata?.provider ?? null,
                            model: result.metadata?.model ?? null,
                            api: result.metadata?.api ?? null,
                            inputUsage: result.inputTokens ?? null,
                            outputUsage: result.outputTokens ?? null,
                            modelLatencyMs: result.modelLatencyMs,
                            evidenceQuality: evidenceQuality(true, conversation, captured.getCwd()),
                        });
                    }

                    return authority.kind === "allow"
                        ? { kind: "allow" }
                        : { kind: "defer" };
                } catch {
                    // A link exception would abort the whole authority chain.
                    // Keep provider/payload/session failures fail-closed and do
                    // not include raw errors or authorization evidence in logs.
                    sink.debug("ai_bash_judge.exception");
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

        const runtimeId = crypto.randomUUID();
        const config = loadJudgeConfig({ agentDir: getAgentDir() });
        // Static candidate-identity fields. The judge and permission-system
        // versions must track package.json / the peer floor; the cohort
        // declaration used exactly these values.
        const identityBase = {
            judge: "@sikongjueluo/pi-permission-ai-judge@0.0.1",
            permissionSystem: "25.4.0",
            promptVersion: PROMPT_VERSION,
            toolSchemaVersion: TOOL_SCHEMA_VERSION,
            reviewSchemaVersion: String(REVIEW_SCHEMA_VERSION),
            timeoutCohort: config.timeoutCohort,
        };
        const promotionRecords = loadPromotionRecords({
            agentDir: getAgentDir(),
        });
        if (promotionRecords.diagnostic !== null) {
            ctx.ui.notify(
                `ai-bash-judge promotion records: ${promotionRecords.diagnostic}; Enforce gates stay closed`,
                "warning",
            );
        }
        root = {
            getSessionId: () => ctx.sessionManager.getSessionId(),
            expectedSessionId: sessionId,
            getModel: () => ctx.model,
            modelRegistry: ctx.modelRegistry,
            shutdown: new AbortController(),
            judgeRuntimeId: runtimeId,
            config,
            reviewLogEnabled: readPermissionReviewLogEnabled(),
            auditLog: createAuditLog({
                agentDir: getAgentDir(),
                runtimeId,
            }),
            promotionRecords,
            identityBase,
            conversation: conversationProbeFromSession(ctx.sessionManager),
            getCwd: () => ctx.sessionManager.getCwd(),
        };
        for (const diagnostic of root.config.diagnostics) {
            ctx.ui.notify(
                `ai-bash-judge config: ${diagnostic.key} — ${diagnostic.problem}; using ${diagnostic.fallback}`,
                "warning",
            );
        }
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
