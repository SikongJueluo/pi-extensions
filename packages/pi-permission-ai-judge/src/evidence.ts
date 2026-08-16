import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

const NATIVE_BASH_TOOL_NAME = "bash";
const FULL_COMMAND_LABEL = "full command";

export interface BashJudgmentEvidence {
    readonly fullCommand: string;
    readonly triggeringUnit?: string;
}

function isNonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * Project a local native-Bash ask from permission-system's complete payload.
 *
 * A `full command` evidence entry is emitted only when the original tool input
 * differs from `request.value`; otherwise the value itself is complete. Any
 * forwarded, aliased, inconsistent, or ambiguous payload defers upstream.
 */
export function buildBashJudgmentEvidence(
    details: PromptPermissionDetails,
): BashJudgmentEvidence | undefined {
    const payload = details.payload;
    const request = payload?.request;

    if (
        request === undefined ||
        !Array.isArray(payload.evidence) ||
        details.forwarding !== undefined ||
        payload.kind !== "bash" ||
        request.requester?.forwarded !== false ||
        details.toolName !== NATIVE_BASH_TOOL_NAME ||
        request.toolName !== NATIVE_BASH_TOOL_NAME ||
        request.invokedToolName !== null ||
        request.surface !== NATIVE_BASH_TOOL_NAME ||
        !isNonBlank(request.value) ||
        (details.command !== undefined && details.command !== request.value)
    ) {
        return undefined;
    }

    const fullCommands = payload.evidence.filter(
        (entry) => entry.label === FULL_COMMAND_LABEL,
    );
    if (fullCommands.length > 1) {
        return undefined;
    }

    const fullCommand =
        fullCommands.length === 0 ? request.value : fullCommands[0]?.text;
    if (!isNonBlank(fullCommand)) {
        return undefined;
    }

    return {
        fullCommand,
        triggeringUnit:
            request.value === fullCommand ? undefined : request.value,
    };
}
