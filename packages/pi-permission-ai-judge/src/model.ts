import type {
    AssistantMessage,
    Context,
    Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildJudgeContext, MAX_REASON_CODE_POINTS, REPORT_VERDICT_TOOL_NAME } from "./prompt";
import type { BashJudgmentEvidence } from "./evidence";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 256;

export type InfrastructureCode =
    | "no_model"
    | "unsupported_api"
    | "timeout"
    | "aborted"
    | "model_error"
    | "missing_tool_call"
    | "invalid_arguments"
    | "invalid_verdict"
    | "invalid_reason";

export type SemanticVerdict = "allow" | "deny" | "defer";

export interface ModelMetadata {
    readonly provider: string;
    readonly model: string;
    readonly api: string;
}

export type ModelAvailability =
    | {
          readonly kind: "ready";
          readonly metadata: ModelMetadata;
          readonly complete: (
              context: Context,
              signal: AbortSignal,
          ) => Promise<AssistantMessage>;
      }
    | { readonly kind: "no_model" }
    | {
          readonly kind: "unsupported_api";
          readonly metadata: ModelMetadata;
      };

export type ModelAttempt =
    | {
          readonly kind: "judgment";
          readonly verdict: SemanticVerdict;
          readonly reason: string;
          readonly metadata: ModelMetadata;
          readonly outputTokens: number;
      }
    | {
          readonly kind: "infrastructure_failure";
          readonly code: InfrastructureCode;
          readonly metadata?: ModelMetadata;
          readonly modelCalled: boolean;
      };

function forcedToolChoice(api: string): unknown | undefined {
    switch (api) {
        case "anthropic-messages":
        case "bedrock-converse-stream":
            return { type: "tool", name: REPORT_VERDICT_TOOL_NAME };
        case "google-generative-ai":
        case "google-vertex":
            return "any";
        case "openai-completions":
        case "mistral-conversations":
        case "pi-messages":
            return {
                type: "function",
                function: { name: REPORT_VERDICT_TOOL_NAME },
            };
        case "openai-responses":
        case "azure-openai-responses":
            return { type: "function", name: REPORT_VERDICT_TOOL_NAME };
        case "openai-codex-responses":
            // Codex supports required but not named tool choice. There is only
            // one tool in the request, so required still forces this tool.
            return "required";
        default:
            return undefined;
    }
}

function enforcesOutputCap(api: string): boolean {
    return api !== "openai-codex-responses";
}

/** Adapt Pi's current model to the one-call structured verdict seam. */
export function createModelAvailability(
    model: Model<any> | undefined,
    registry: ModelRegistry,
): ModelAvailability {
    if (model === undefined) {
        return { kind: "no_model" };
    }

    const metadata: ModelMetadata = {
        provider: model.provider,
        model: model.id,
        api: model.api,
    };
    const toolChoice = forcedToolChoice(model.api);
    if (toolChoice === undefined) {
        return { kind: "unsupported_api", metadata };
    }

    return {
        kind: "ready",
        metadata,
        complete: (context, signal) => {
            const options: Record<string, unknown> = {
                signal,
                maxRetries: 0,
                cacheRetention: "none",
                toolChoice,
            };
            if (enforcesOutputCap(model.api)) {
                options.maxTokens = MAX_OUTPUT_TOKENS;
            }
            return registry.complete(model, context, options as never);
        },
    };
}

function isVerdict(value: unknown): value is SemanticVerdict {
    return value === "allow" || value === "deny" || value === "defer";
}

function codePointLength(value: string): number {
    return [...value].length;
}

/** Make one bounded completion and accept only one `report_verdict` tool call. */
export async function requestStructuredVerdict(
    availability: ModelAvailability,
    evidence: BashJudgmentEvidence,
    shutdownSignal: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ModelAttempt> {
    if (availability.kind !== "ready") {
        return {
            kind: "infrastructure_failure",
            code: availability.kind,
            metadata:
                availability.kind === "unsupported_api"
                    ? availability.metadata
                    : undefined,
            modelCalled: false,
        };
    }

    let modelCalled = false;
    const failure = (code: InfrastructureCode): ModelAttempt => ({
        kind: "infrastructure_failure",
        code,
        metadata: availability.metadata,
        modelCalled,
    });
    const timeoutController = new AbortController();
    const requestController = new AbortController();
    const abortFromShutdown = (): void => requestController.abort();
    const abortFromTimeout = (): void => requestController.abort();
    shutdownSignal.addEventListener("abort", abortFromShutdown, { once: true });
    timeoutController.signal.addEventListener("abort", abortFromTimeout, {
        once: true,
    });
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

    try {
        if (shutdownSignal.aborted) {
            return failure("aborted");
        }

        modelCalled = true;
        const response = await availability.complete(
            buildJudgeContext(evidence),
            requestController.signal,
        );

        if (shutdownSignal.aborted || response.stopReason === "aborted") {
            return failure("aborted");
        }
        if (timeoutController.signal.aborted) {
            return failure("timeout");
        }
        if (response.stopReason === "error") {
            return failure("model_error");
        }

        const outputTokens = response.usage.output;
        if (
            !Number.isFinite(outputTokens) ||
            outputTokens <= 0 ||
            outputTokens > MAX_OUTPUT_TOKENS
        ) {
            return failure("model_error");
        }

        const calls = response.content.filter(
            (part) => part.type === "toolCall",
        );
        if (
            calls.length !== 1 ||
            calls[0]?.name !== REPORT_VERDICT_TOOL_NAME
        ) {
            return failure("missing_tool_call");
        }

        const args = calls[0].arguments;
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
            return failure("invalid_arguments");
        }
        const keys = Object.keys(args).sort();
        if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "verdict") {
            return failure("invalid_arguments");
        }
        if (!isVerdict(args.verdict)) {
            return failure("invalid_verdict");
        }
        if (typeof args.reason !== "string") {
            return failure("invalid_reason");
        }

        const reason = args.reason.trim();
        if (
            reason.length === 0 ||
            codePointLength(reason) > MAX_REASON_CODE_POINTS
        ) {
            return failure("invalid_reason");
        }

        return {
            kind: "judgment",
            verdict: args.verdict,
            reason,
            metadata: availability.metadata,
            outputTokens,
        };
    } catch {
        const code: InfrastructureCode = shutdownSignal.aborted
            ? "aborted"
            : timeoutController.signal.aborted
              ? "timeout"
              : "model_error";
        return failure(code);
    } finally {
        clearTimeout(timer);
        shutdownSignal.removeEventListener("abort", abortFromShutdown);
        timeoutController.signal.removeEventListener("abort", abortFromTimeout);
    }
}
