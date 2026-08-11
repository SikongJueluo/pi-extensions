import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
    AuthorizerLog,
    AuthorizerVerdict,
    PermissionQuery,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
    NATIVE_BASH_TOOL_NAME,
    recoverNativeBashCommand,
} from "@sikongjueluo/pi-permission-shared";
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
    getEntries(): ReadonlyArray<SessionEntry>;
    getSessionId(): string;
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
 * Inner-command Authorizer decision (ADR 0001).
 *
 * Revalidates root ownership, recovers the complete native Bash command for
 * `details.toolCallId` from the captured session, then hands it to the first
 * registered handler that claims it. Each handler owns its own recognition and
 * verdict logic: the timeout handler unwraps one level and re-evaluates the
 * inner command; the env handler defers as non-transparent.
 *
 * Every uncertain path — forwarded requests, a session-identity mismatch,
 * non-Bash tools, missing session evidence, an unrecognized command, or any
 * exception — defers to the next authority (fail-closed).
 *
 * Logging: handlers emit their own review/debug events for decisive and
 * notable-defer outcomes; silent deferrals log nothing. Exceptions are logged
 * by this engine as `inner_cmd.exception`, retaining the recovered command and
 * any partial evidence the active handler recorded before throwing.
 */
export async function authorizeInnerCommand(
    deps: InnerCommandAuthorizerDeps,
): Promise<AuthorizerVerdict> {
    const { details, query, log, session, expectedSessionId } = deps;

    // Track recovered evidence so an exception after recognition can retain it.
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

        // Only the native Bash tool is unwrappable, and only when the ask is
        // tied to a specific tool call.
        if (details.toolName !== NATIVE_BASH_TOOL_NAME) {
            return { kind: "defer" };
        }
        const toolCallId = details.toolCallId;
        if (toolCallId === undefined) {
            return { kind: "defer" };
        }

        // Recover the complete Bash input from the session, never from
        // details.command or details.message.
        command = recoverNativeBashCommand(session.getEntries(), toolCallId);
        if (command === undefined) {
            return { kind: "defer" };
        }

        // Dispatch to the first registered handler that claims the command.
        for (const handler of handlers) {
            evidence = {};
            const verdict = handler.decide({ command, details, query, log, evidence });
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
