import type {
    AuthorizerLog,
    AuthorizerVerdict,
    PermissionQuery,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { handlers } from "./handlers";

/** Convert a thrown value into a short, log-safe string. */
function toErrorString(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Live read access to the captured session at authorize time.
 *
 * The real `ReadonlySessionManager` satisfies this structurally; tests inject a
 * stub so the decision logic stays pure and deterministic.
 */
export interface SessionProbe {
    getSessionId(): string;
}

const NATIVE_BASH_TOOL_NAME = "bash";
const FULL_COMMAND_LABEL = "full command";

interface BashCommandEvidence {
    readonly fullCommand: string;
    readonly triggeringUnit: string;
}

function isNonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** Read a complete direct native-Bash ask from the structured prompt payload. */
export function extractBashCommandEvidence(
    details: PromptPermissionDetails,
): BashCommandEvidence | undefined {
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

    return { fullCommand, triggeringUnit: request.value };
}

/** Dependencies injected into the pure authorizer decision. */
export interface InnerCommandAuthorizerDeps {
    readonly details: PromptPermissionDetails;
    readonly query: PermissionQuery;
    readonly log: AuthorizerLog;
    /** Live reader for the captured UI-root session. */
    readonly session: SessionProbe;
    /**
     * Session identity captured at registration as root-ownership provenance.
     * Revalidated against {@link SessionProbe.getSessionId} before any decisive
     * verdict so a stale or replaced session can never be judged.
     */
    readonly expectedSessionId: string;
}

/**
 * Inner-command Authorizer decision (ADRs 0001 and 0004).
 *
 * Revalidates root ownership, reads the complete native Bash command from the
 * structured prompt payload, then hands it to the first registered handler that
 * claims it. Each handler owns its own recognition and verdict logic: the
 * timeout handler unwraps one level and re-evaluates the inner command; the env
 * handler defers as non-transparent.
 *
 * Every uncertain path — forwarded requests, a session-identity mismatch,
 * non-Bash tools, malformed payload evidence, an unrecognized command, or any
 * exception — defers to the next authority (fail-closed).
 *
 * Logging: handlers emit their own review/debug events for decisive and
 * notable-defer outcomes; silent deferrals log nothing. Exceptions are logged
 * by this engine as `inner_cmd.exception`, retaining the structured command and
 * any partial evidence the active handler recorded before throwing.
 */
export async function authorizeInnerCommand(
    deps: InnerCommandAuthorizerDeps,
): Promise<AuthorizerVerdict> {
    const { details, query, log, session, expectedSessionId } = deps;

    // Track structured evidence so an exception after recognition can retain it.
    let command: string | undefined;
    let evidence: Record<string, unknown> = {};

    try {
        // Forwarded subagent asks are out of scope: the captured session is the
        // serving root's conversation, not the requester's.
        if (details.forwarding) {
            return { kind: "defer" };
        }

        // Revalidate root ownership: the live session must still be the one we
        // registered for.
        const currentSessionId = session.getSessionId();
        if (currentSessionId !== expectedSessionId) {
            log.debug("inner_cmd.session_mismatch", {
                expectedSessionId,
                currentSessionId,
            });
            return { kind: "defer" };
        }

        // The payload is complete by contract. A "full command" evidence entry
        // exists only when it differs from request.value; otherwise that value
        // is the complete command. Ambiguous or inconsistent payloads defer.
        const commandEvidence = extractBashCommandEvidence(details);
        if (commandEvidence === undefined) {
            return { kind: "defer" };
        }
        command = commandEvidence.fullCommand;

        // Dispatch to the first registered handler that claims the command.
        for (const handler of handlers) {
            evidence = {};
            const verdict = handler.decide({
                command,
                unit: commandEvidence.triggeringUnit,
                details,
                query,
                log,
                evidence,
            });
            if (verdict !== undefined) {
                return verdict;
            }
        }
        return { kind: "defer" };
    } catch (error) {
        const exceptionDetails: Record<string, unknown> = {
            error: toErrorString(error),
        };
        if (command !== undefined) {
            exceptionDetails.command = command;
        }
        Object.assign(exceptionDetails, evidence);
        log.debug("inner_cmd.exception", exceptionDetails);
        return { kind: "defer" };
    }
}
