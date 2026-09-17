import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_DECISION_CHANNEL,
    PERMISSIONS_READY_CHANNEL,
    type PermissionDecisionEvent,
    type PromptPermissionDetails,
    type AuthorizerLog,
    type AuthorizerVerdict,
} from "@gotgenes/pi-permission-system";
import { buildBashJudgmentEvidence, type BashJudgmentEvidence } from "./evidence/bash";
import {
    createModelAvailability,
    requestStructuredVerdict,
    type ModelAvailability,
    type ModelAttempt,
} from "./judge/model";
import { PROMPT_VERSION, TOOL_SCHEMA_VERSION } from "./judge/prompt";
import { loadJudgeConfig, type EffectiveJudgeConfig } from "./config/judge";
import { createReviewSink, type ReviewSink } from "./telemetry/review";
import { createAuditLog, type AuditLog } from "./telemetry/audit";
import {
    buildConversationEvidence,
    conversationProbeFromSession,
    type ConversationEvidence,
} from "./evidence/conversation";
import { classifyHighRisk, type HighRiskMatch } from "./authority/highrisk";
import {
    AdvicePresenter,
    type AdviceFocus,
    type AdviceView,
} from "./advice/widget";
import { evaluateEnforceAuthority, type EnforceGateState } from "./authority/enforce";
import {
    classifyModel,
    loadModelCatalog,
    DEFAULT_CATALOG_PATH,
    type ModelCatalogClassification,
    type LoadedModelCatalog,
} from "./config/catalog";

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
    /** Dialog-advice widget presenter (no-op when disabled by config). */
    readonly advice: AdvicePresenter;
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

/**
 * Resolve the judge model for one ask (ADR 0008 / PIEXTENSIO-23).
 *
 * A configured v2 `model` is a fixed judge model resolved per ask against
 * the live registry. Resolution failure (unknown model, no configured
 * auth) is reported as an explicit failure — never a silent fallback to
 * the session model. No configured model follows the session model
 * (legacy behavior).
 */
function resolveJudgeModel(
    config: EffectiveJudgeConfig,
    sessionModel: Model<any> | undefined,
    registry: ModelRegistry,
): { kind: "model"; model: Model<any> | undefined; source: "configured" | "session" } | { kind: "unavailable" } {
    if (config.judgeModel === undefined) {
        return { kind: "model", model: sessionModel, source: "session" };
    }
    const found = registry.find(config.judgeModel.provider, config.judgeModel.id);
    if (found === undefined || !registry.hasConfiguredAuth(found)) {
        return { kind: "unavailable" };
    }
    return { kind: "model", model: found, source: "configured" };
}

/** Per-call emission context shared by the result emitters. */
interface EmitContext {
    readonly captured: RootSession;
    readonly details: PromptPermissionDetails;
    readonly startedAt: number;
    readonly emitResult: (record: Record<string, unknown>) => void;
}

/** Shared identity/cohort fields; latency is measured at emit time. */
function emitBase(ctx: EmitContext): Record<string, unknown> {
    return resultBase(
        ctx.captured.judgeRuntimeId,
        ctx.details,
        ctx.startedAt,
        ctx.captured.config,
    );
}

/**
 * Emit a `preflight_defer` result (fail-closed before the model runs) and
 * return the matching defer verdict.
 */
function preflightDefer(
    ctx: EmitContext,
    code: string,
    eq: Record<string, unknown>,
    extra: Record<string, unknown> = {},
): AuthorizerVerdict {
    ctx.emitResult({
        ...emitBase(ctx),
        resultKind: "preflight_defer",
        verdict: null,
        effectiveVerdict: "defer",
        modelCalled: false,
        code,
        ...extra,
        evidenceQuality: eq,
    });
    return { kind: "defer" };
}

/**
 * Emit an `infrastructure_failure` result with a defer verdict (e.g. the
 * judge model cannot be resolved).
 */
function infrastructureDefer(
    ctx: EmitContext,
    code: string,
    eq: Record<string, unknown>,
    extra: Record<string, unknown> = {},
): AuthorizerVerdict {
    ctx.emitResult({
        ...emitBase(ctx),
        resultKind: "infrastructure_failure",
        verdict: null,
        effectiveVerdict: "defer",
        modelCalled: false,
        code,
        ...extra,
        evidenceQuality: eq,
    });
    return { kind: "defer" };
}

/** Emit the `judgment` result for a model call that returned a verdict. */
function emitJudgmentResult(
    ctx: EmitContext,
    result: Extract<ModelAttempt, { readonly kind: "judgment" }>,
    conversation: ConversationEvidence,
    effectiveVerdict: "allow" | "defer",
    authorityBlockedBy: string | null,
    modelSource: "configured" | "session",
    risk: HighRiskMatch | undefined,
): void {
    ctx.emitResult({
        ...emitBase(ctx),
        resultKind: "judgment",
        verdict: result.verdict,
        effectiveVerdict,
        authorityBlockedBy,
        modelCalled: true,
        code: null,
        modelSource,
        provider: result.metadata.provider,
        model: result.metadata.model,
        api: result.metadata.api,
        riskOverride: risk ?? null,
        // Log keys deliberately avoid the substring
        // "token": permission-system masks any key matching
        // /token/i (structural key-name redaction), which
        // would erase usage telemetry from the review log.
        inputUsage: result.inputTokens,
        outputUsage: result.outputTokens,
        modelLatencyMs: result.modelLatencyMs,
        reasonLength: reasonLength(result.reason),
        evidenceQuality: evidenceQuality(true, conversation, ctx.captured.getCwd()),
    });
}

/** Emit the post-model `infrastructure_failure` result under authority. */
function emitInfrastructureResult(
    ctx: EmitContext,
    result: Extract<ModelAttempt, { readonly kind: "infrastructure_failure" }>,
    conversation: ConversationEvidence,
    effectiveVerdict: "allow" | "defer",
    authorityBlockedBy: string | null,
    modelSource: "configured" | "session",
    risk: HighRiskMatch | undefined,
): void {
    ctx.emitResult({
        ...emitBase(ctx),
        resultKind: "infrastructure_failure",
        verdict: null,
        effectiveVerdict,
        authorityBlockedBy,
        modelCalled: result.modelCalled,
        code: result.code,
        modelSource,
        provider: result.metadata?.provider ?? null,
        model: result.metadata?.model ?? null,
        api: result.metadata?.api ?? null,
        riskOverride: risk ?? null,
        inputUsage: result.inputTokens ?? null,
        outputUsage: result.outputTokens ?? null,
        modelLatencyMs: result.modelLatencyMs,
        evidenceQuality: evidenceQuality(true, conversation, ctx.captured.getCwd()),
    });
}

/**
 * Judge-owned enrollment record (ADR 0006 denominator: asks the Judge
 * received, per its own audit log). Non-bash surfaces are ignored later
 * without a shadow row; they also do not enroll (v0.1 cohort is bash-only).
 */
function auditEnrollment(
    captured: RootSession,
    details: PromptPermissionDetails,
): void {
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
}

/** A preflight-gate outcome: proceed with usable evidence, or stop. */
type PreflightGate =
    | {
        readonly kind: "proceed";
        readonly evidence: BashJudgmentEvidence;
        readonly risk: HighRiskMatch | undefined;
    }
    | { readonly kind: "stop"; readonly verdict: AuthorizerVerdict };

/**
 * Fail-closed preflight gates, in order:
 * 1. Forwarded asks do not carry a structured child full command in
 *    permission-system 25.3/25.4 — never parse the legacy prose. The
 *    deferral is recorded so the request stays visible in the offline
 *    denominator instead of silently vanishing.
 * 2. Unrelated permission surfaces produce no Shadow row and no model
 *    call: the v0.1 cohort selects accessSurface = bash only.
 * 3. Session ownership must be proven.
 * 4. Evidence must be structured and valid.
 * 5. Built-in high-risk override (ADR 0008): clear-cut irreversible/system
 *    shapes always defer. In Enforce the model is skipped entirely; in
 *    Shadow it still runs for quality observation and the override is
 *    recorded.
 */
function runPreflightGates(
    ctx: EmitContext,
    captured: RootSession,
    details: PromptPermissionDetails,
): PreflightGate {
    if (
        details.forwarding !== undefined ||
        details.payload.kind === "forwarded"
    ) {
        ctx.captured.advice.present(details.requestId, {
            state: "unavailable",
            cause: "forwarded ask carries no structured bash input",
        });
        return {
            kind: "stop",
            verdict: preflightDefer(
                ctx,
                "missing_structured_input",
                evidenceQuality(false, EMPTY_CONVERSATION, "", false),
            ),
        };
    }

    if (details.payload.kind !== "bash") {
        return { kind: "stop", verdict: { kind: "defer" } };
    }

    if (captured.getSessionId() !== captured.expectedSessionId) {
        ctx.captured.advice.present(details.requestId, {
            state: "unavailable",
            cause: "session ownership unproven",
        });
        return {
            kind: "stop",
            verdict: preflightDefer(
                ctx,
                "session_ownership_unproven",
                evidenceQuality(false, EMPTY_CONVERSATION, ""),
            ),
        };
    }

    const evidence = buildBashJudgmentEvidence(details);
    if (evidence === undefined) {
        ctx.captured.advice.present(details.requestId, {
            state: "unavailable",
            cause: "bash evidence missing or invalid",
        });
        return {
            kind: "stop",
            verdict: preflightDefer(
                ctx,
                "invalid_evidence",
                evidenceQuality(false, EMPTY_CONVERSATION, ""),
            ),
        };
    }

    const risk = classifyHighRisk(evidence.fullCommand);
    if (risk !== undefined && captured.config.mode === "enforce") {
        ctx.captured.advice.present(
            details.requestId,
            { state: "skipped", category: risk.category, rule: risk.rule },
            buildAdviceFocus(evidence, risk, details),
        );
        return {
            kind: "stop",
            verdict: preflightDefer(
                ctx,
                "high_risk_override",
                evidenceQuality(true, EMPTY_CONVERSATION, captured.getCwd()),
                { riskCategory: risk.category, riskRule: risk.rule },
            ),
        };
    }

    return { kind: "proceed", evidence, risk };
}

/** Prepared model-call inputs; undefined when an infra defer was emitted. */
interface PreparedModelCall {
    readonly availability: ModelAvailability;
    readonly modelSource: "configured" | "session";
}

/**
 * Per-request judge-model resolution (PIEXTENSIO-3 cat.3 for the session
 * model; ADR 0008 for a configured fixed model). A configured model that
 * cannot be resolved is an observable infrastructure failure — never a
 * silent fallback to the session model.
 */
function prepareModelCall(
    ctx: EmitContext,
    captured: RootSession,
    risk: HighRiskMatch | undefined,
): PreparedModelCall | undefined {
    const resolved = resolveJudgeModel(
        captured.config,
        captured.getModel(),
        captured.modelRegistry,
    );
    if (resolved.kind === "unavailable") {
        ctx.captured.advice.present(ctx.details.requestId, {
            state: "unavailable",
            cause: "judge model unresolved",
        });
        infrastructureDefer(
            ctx,
            "judge_model_unavailable",
            evidenceQuality(true, EMPTY_CONVERSATION, captured.getCwd()),
            {
                provider: captured.config.judgeModel?.provider ?? null,
                model: captured.config.judgeModel?.id ?? null,
                api: null,
                riskOverride: risk ?? null,
            },
        );
        return undefined;
    }
    return {
        availability: createModelAvailability(
            resolved.model,
            captured.modelRegistry,
        ),
        modelSource: resolved.source,
    };
}

/**
 * Enforce truth table (PIEXTENSIO-3 cat.4 / M5; ADR 0008): the fail-closed
 * runtime health gates — audit health, telemetry, result kind, verdict,
 * review acknowledgement, generation currency — are the single authority
 * seam; the retired promotion gates are no longer inputs.
 * reviewAcknowledged is true in the ADR 0006 sense: the Judge-owned audit
 * write for this result happens before the authority return, and a failed
 * write flips auditHealthy sticky-unhealthy, closing authority for every
 * later ask.
 */
function enforceAndEmit(
    ctx: EmitContext,
    captured: RootSession,
    sink: ReviewSink,
    result: ModelAttempt,
    conversation: ConversationEvidence,
    risk: HighRiskMatch | undefined,
    modelSource: "configured" | "session",
    adviceFocus: AdviceFocus | undefined,
): AuthorizerVerdict {
    const gateState: EnforceGateState = {
        auditHealthy: captured.auditLog.healthy(),
        telemetryHealth: sink.health(),
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
        emitJudgmentResult(
            ctx, result, conversation,
            effectiveVerdict, authorityBlockedBy, modelSource, risk,
        );
    } else {
        emitInfrastructureResult(
            ctx, result, conversation,
            effectiveVerdict, authorityBlockedBy, modelSource, risk,
        );
    }

    // Dialog advice rides only the defer arm: an Enforce allow never shows
    // a dialog, so there is nothing for the widget to annotate — instead a
    // transient notify keeps the auto-approval auditable.
    if (authority.kind === "allow") {
        if (result.kind === "judgment") {
            ctx.captured.advice.notifyAllowed(result.reason);
        }
        return { kind: "allow" };
    }

    const view: AdviceView =
        result.kind === "judgment"
            ? {
                  state: "judgment",
                  verdict: result.verdict,
                  reason: result.reason,
                  shadow: captured.config.mode === "shadow",
              }
            : {
                  state: "unavailable",
                  cause: `model call failed (${result.kind})`,
              };
    ctx.captured.advice.present(
        ctx.details.requestId,
        view,
        adviceFocus,
    );
    return { kind: "defer" };
}

/**
 * One authorize call: enroll, preflight-gate, judge, and enforce the truth
 * table. Extracted from the registerAuthorizer callback so each stage reads
 * linearly; any exception fails closed (defer) without logging raw errors.
 */
async function judgeAuthorize(
    captured: RootSession,
    details: PromptPermissionDetails,
    log: AuthorizerLog,
): Promise<AuthorizerVerdict> {
    const startedAt = Date.now();
    const sink: ReviewSink = createReviewSink({
        log,
        reviewLogEnabled: captured.reviewLogEnabled,
    });
    try {
        const ctx: EmitContext = {
            captured,
            details,
            startedAt,
            emitResult: (record) => {
                sink.review("ai_bash_judge.result", record);
                captured.auditLog.audit("ai_bash_judge.result", record);
            },
        };

        auditEnrollment(captured, details);

        const gate = runPreflightGates(ctx, captured, details);
        if (gate.kind === "stop") {
            return gate.verdict;
        }

        const prepared = prepareModelCall(ctx, captured, gate.risk);
        if (prepared === undefined) {
            return { kind: "defer" };
        }

        // Conversation evidence is captured at ask time from the
        // live serving branch, not at session start: the newest
        // user intent is the ask's intent.
        const conversation: ConversationEvidence =
            buildConversationEvidence(captured.conversation);
        const result = await requestStructuredVerdict(
            prepared.availability,
            gate.evidence,
            captured.shutdown.signal,
            captured.config.timeoutMs,
            conversation,
        );

        return enforceAndEmit(
            ctx, captured, sink, result, conversation, gate.risk,
            prepared.modelSource,
            buildAdviceFocus(gate.evidence, gate.risk, details),
        );
    } catch {
        // A link exception would abort the whole authority chain.
        // Keep provider/payload/session failures fail-closed and do
        // not include raw errors or authorization evidence in logs.
        sink.debug("ai_bash_judge.exception");
        captured.advice.present(details.requestId, {
            state: "unavailable",
            cause: "judge internal error",
        });
        return { kind: "defer" };
    }
}

/**
 * Focus cascade for the dialog-advice widget (PIEXTENSIO-13): the
 * high-risk match segment when one exists, else the unit that triggered
 * the ask, else the executed unit the payload carries. Omitted when the
 * payload offers nothing narrower than the full command.
 */
function buildAdviceFocus(
    evidence: BashJudgmentEvidence,
    risk: HighRiskMatch | undefined,
    details: PromptPermissionDetails,
): AdviceFocus | undefined {
    if (risk !== undefined) {
        return {
            segment: evidence.triggeringUnit ?? evidence.fullCommand,
            origin: "high-risk",
            category: risk.category,
        };
    }
    if (evidence.triggeringUnit !== undefined) {
        return {
            segment: evidence.triggeringUnit,
            origin: "triggering-unit",
        };
    }
    const executedUnit = details.payload.request.executedUnit;
    if (executedUnit !== null && executedUnit !== undefined) {
        return { segment: executedUnit, origin: "executed-unit" };
    }
    return undefined;
}

/**
 * One non-blocking session notice in Enforce mode: the effective judge
 * model and the risk contract in one line (ADR 0008). Not repeated per
 * ask. The advisory model catalog (PIEXTENSIO-24) only annotates this
 * notice — it never gates authority.
 */
function notifyEnforceActive(
    notify: (message: string, kind: "info" | "warning") => void,
    config: EffectiveJudgeConfig,
    sessionModel: Model<any> | undefined,
    catalog: LoadedModelCatalog,
): void {
    const configured = config.judgeModel;
    let judgeModelDescription: string;
    let classification: ModelCatalogClassification | null;
    if (configured !== undefined) {
        judgeModelDescription = `${configured.provider}/${configured.id}`;
        classification = classifyModel(
            catalog,
            configured.provider,
            configured.id,
        );
    } else {
        if (sessionModel === undefined) {
            judgeModelDescription = "session model (none yet)";
            classification = null;
        } else {
            judgeModelDescription = `${sessionModel.provider}/${sessionModel.id} (session model)`;
            classification = classifyModel(
                catalog,
                sessionModel.provider,
                sessionModel.id,
            );
        }
    }
    const catalogNote =
        classification === "unlisted"
            ? " Model untested in advisory catalog."
            : classification === "deprecated" || classification === "revoked"
              ? ` Catalog status: ${classification}.`
              : "";
    notify(
        `ai-bash-judge Enforce active — ${judgeModelDescription} may auto-allow Bash; high-risk commands still ask.${catalogNote}`,
        "info",
    );
}


/** Register a Shadow-only structured-output judge for local native Bash asks. */
export default function permissionAiJudge(pi: ExtensionAPI): void {
    let root: RootSession | undefined;
    let disposeAuthorizer: (() => void) | undefined;

    function tryRegister(): void {
        if (disposeAuthorizer !== undefined || root === undefined) {
            return;
        }

        // Resolve the service by the live session id: the ready channel
        // re-emits after a mid-session republish (31.1.4), and the dynamic
        // read re-keys onto the new slot without extra state.
        const service = getPermissionsService(root.getSessionId());
        if (service === undefined) {
            return;
        }

        const captured = root;
        disposeAuthorizer = service.registerAuthorizer(
            LINK_NAME,
            async (details, _query, log) =>
                judgeAuthorize(captured, details, log),
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
            conversation: conversationProbeFromSession(ctx.sessionManager),
            getCwd: () => ctx.sessionManager.getCwd(),
            advice: new AdvicePresenter(
                ctx.ui,
                (message, kind) => ctx.ui.notify(message, kind),
                config.dialogAdvice,
            ),
        };
        for (const diagnostic of root.config.diagnostics) {
            ctx.ui.notify(
                `ai-bash-judge config: ${diagnostic.key} — ${diagnostic.problem}; using ${diagnostic.fallback}`,
                "warning",
            );
        }
        // One non-blocking session notice in Enforce mode: the risk
        // contract and the effective judge model (ADR 0008). Not repeated
        // per ask. The advisory model catalog (PIEXTENSIO-24) only
        // annotates this notice — it never gates authority.
        const catalogResult = loadModelCatalog({
            catalogPath: DEFAULT_CATALOG_PATH,
        });
        for (const diagnostic of catalogResult.diagnostics) {
            ctx.ui.notify(
                `ai-bash-judge catalog: ${diagnostic.key} — ${diagnostic.problem}; treated as empty`,
                "warning",
            );
        }
        if (root.config.mode === "enforce") {
            notifyEnforceActive(
                (message, kind) => ctx.ui.notify(message, kind),
                root.config,
                ctx.model,
                catalogResult.catalog,
            );
        }
        tryRegister();
    });

    pi.events.on(PERMISSIONS_READY_CHANNEL, tryRegister);

    // Dialog-advice lifecycle (PIEXTENSIO-13): the permission system
    // broadcasts one decision per request; the one resolving the request
    // the widget describes takes the widget down with it.
    pi.events.on(
        PERMISSIONS_DECISION_CHANNEL,
        (data: unknown) => {
            const event = data as PermissionDecisionEvent;
            root?.advice.handleDecision(event.requestId);
        },
    );

    pi.on("session_shutdown", () => {
        root?.shutdown.abort();
        root?.advice.shutdown();
        disposeAuthorizer?.();
        disposeAuthorizer = undefined;
        root = undefined;
    });
}
