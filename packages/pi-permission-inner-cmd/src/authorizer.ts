import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
    AuthorizerLog,
    AuthorizerVerdict,
    PermissionQuery,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { classifyWrapper, isRecognizedWrapper } from "./recognizer";
import {
    NATIVE_BASH_TOOL_NAME,
    recoverNativeBashCommand,
} from "@sikongjueluo/pi-permission-shared";

/** Bash permission surface queried when re-evaluating the inner command. */
const BASH_SURFACE = "bash";

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
 * V0.1 inner-command Authorizer decision (ADR 0001).
 *
 * Recovers the complete native Bash command for `details.toolCallId` from the
 * captured session, unwraps one strict `timeout` level, and re-evaluates the
 * inner command through the deterministic permission policy. Every uncertain
 * path — forwarded requests, a session-identity mismatch, non-Bash tools,
 * missing/duplicate/malformed session evidence, unsupported or nested wrapper
 * syntax, parse failures, and exceptions — defers to the next authority.
 *
 * Logging contract:
 * - `review` only for a recognized wrapper whose inner command resolves to a
 *   decisive `allow`/`deny`.
 * - `debug` for a recognized inner `ask`, unsupported timeout syntax, nested
 *   wrappers, a session-identity mismatch, and exceptions.
 * - ordinary non-timeout commands defer silently.
 * - recognized logs carry both `command` and `innerCommand`; an exception after
 *   recognition retains both alongside `error`, while an earlier exception logs
 *   only the safe data available at that point.
 */
export async function authorizeInnerCommand(
    deps: InnerCommandAuthorizerDeps,
): Promise<AuthorizerVerdict> {
    const { details, query, log, session, expectedSessionId } = deps;

    // Track recovered evidence so an exception after recognition can retain it.
    let command: string | undefined;
    let innerCommand: string | undefined;

    try {
        // Forwarded subagent asks are out of scope for v0.1: the captured
        // session is the serving root's conversation, not the requester's.
        if (details.forwarding) {
            return { kind: "defer" };
        }

        // Revalidate root ownership: the live session must still be the one we
        // registered for. A mismatch (or a session id that cannot be read)
        // means the captured conversation can no longer be attributed safely.
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

        const classification = classifyWrapper(command);

        switch (classification.kind) {
            case "nonTimeout":
                // An ordinary Bash command this authorizer does not unwrap.
                return { kind: "defer" };

            case "unsupportedTimeout":
                log.debug("inner_cmd.unsupported_timeout_syntax", { command });
                return { kind: "defer" };

            case "recognized": {
                innerCommand = classification.match.innerCommand;

                // Never unwrap more than one level in v0.1.
                if (isRecognizedWrapper(innerCommand)) {
                    log.debug("inner_cmd.nested_timeout", {
                        command,
                        innerCommand,
                    });
                    return { kind: "defer" };
                }

                const result = query.checkPermission(
                    BASH_SURFACE,
                    innerCommand,
                    details.agentName ?? undefined,
                );

                switch (result.state) {
                    case "allow":
                        log.review("inner_cmd.allow", {
                            command,
                            innerCommand,
                        });
                        return { kind: "allow" };
                    case "deny":
                        log.review("inner_cmd.deny", {
                            command,
                            innerCommand,
                        });
                        return { kind: "deny" };
                    case "ask":
                    default:
                        // Treat any unexpected state as a safe defer.
                        log.debug("inner_cmd.inner_ask", {
                            command,
                            innerCommand,
                        });
                        return { kind: "defer" };
                }
            }
        }
    } catch (error) {
        const exceptionDetails: Record<string, unknown> = {
            error: toErrorString(error),
        };
        if (command !== undefined) {
            exceptionDetails.command = command;
        }
        if (innerCommand !== undefined) {
            exceptionDetails.innerCommand = innerCommand;
        }
        log.debug("inner_cmd.exception", exceptionDetails);
        return { kind: "defer" };
    }
}
