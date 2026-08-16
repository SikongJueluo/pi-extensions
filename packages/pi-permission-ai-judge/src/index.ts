import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";
import { buildBashJudgmentEvidence } from "./evidence";
import {
    createModelAvailability,
    requestStructuredVerdict,
    type ModelAvailability,
} from "./model";

const LINK_NAME = "ai-bash-judge";
const REVIEW_SCHEMA_VERSION = 1;

interface RootSession {
    readonly getSessionId: () => string;
    readonly expectedSessionId: string;
    readonly model: ModelAvailability;
    readonly shutdown: AbortController;
}

function reasonLength(reason: string): number {
    return [...reason].length;
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
                try {
                    // Forwarded asks do not carry a structured child full command in
                // permission-system 25.3/25.4. Never parse the legacy prose.
                if (
                    details.forwarding !== undefined ||
                    details.payload.kind === "forwarded"
                ) {
                    return { kind: "defer" };
                }

                if (captured.getSessionId() !== captured.expectedSessionId) {
                    log.debug("ai_bash_judge.root_session_mismatch");
                    return { kind: "defer" };
                }

                // Ignore unrelated permission surfaces without producing a
                // Shadow row or invoking the model.
                if (details.payload.kind !== "bash") {
                    return { kind: "defer" };
                }

                const evidence = buildBashJudgmentEvidence(details);
                if (evidence === undefined) {
                    log.review("ai_bash_judge.result", {
                        schemaVersion: REVIEW_SCHEMA_VERSION,
                        requestId: details.requestId,
                        mode: "shadow",
                        origin: "local",
                        resultKind: "preflight_defer",
                        verdict: null,
                        effectiveVerdict: "defer",
                        modelCalled: false,
                        code: "invalid_evidence",
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
                        schemaVersion: REVIEW_SCHEMA_VERSION,
                        requestId: details.requestId,
                        mode: "shadow",
                        origin: "local",
                        resultKind: "judgment",
                        verdict: result.verdict,
                        effectiveVerdict: "defer",
                        modelCalled: true,
                        code: null,
                        provider: result.metadata.provider,
                        model: result.metadata.model,
                        api: result.metadata.api,
                        // Log key deliberately avoids the substring "token":
                        // permission-system masks any key matching /token/i
                        // (structural key-name redaction), which would erase
                        // this usage telemetry from the review log.
                        outputUsage: result.outputTokens,
                        reasonLength: reasonLength(result.reason),
                    });
                } else {
                    log.review("ai_bash_judge.result", {
                        schemaVersion: REVIEW_SCHEMA_VERSION,
                        requestId: details.requestId,
                        mode: "shadow",
                        origin: "local",
                        resultKind: "infrastructure_failure",
                        verdict: null,
                        effectiveVerdict: "defer",
                        modelCalled: result.modelCalled,
                        code: result.code,
                        provider: result.metadata?.provider ?? null,
                        model: result.metadata?.model ?? null,
                        api: result.metadata?.api ?? null,
                        outputUsage: result.outputTokens ?? null,
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
