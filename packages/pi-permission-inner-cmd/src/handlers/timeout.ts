import { classifyWrapper, isRecognizedWrapper } from "../recognizer";
import type { CommandHandler } from "./types";

/** Bash permission surface queried when re-evaluating the inner command. */
const BASH_SURFACE = "bash";

/**
 * The strict simple-timeout wrapper handler (ADR 0001).
 *
 * Unwraps `timeout <duration> <command>`, rejects nested wrappers, and
 * re-evaluates the complete inner program through the deterministic policy.
 * Unsupported timeout syntax and nested wrappers defer with a debug log.
 * Commands that are not timeout at all return `undefined` so the engine can try
 * the next handler.
 */
export const timeoutHandler: CommandHandler = {
    id: "timeout",
    decide(ctx) {
        const { command, details, query, log, evidence } = ctx;
        const classification = classifyWrapper(command);
        switch (classification.kind) {
            case "nonTimeout":
                return undefined;
            case "unsupportedTimeout":
                log.debug("inner_cmd.unsupported_timeout_syntax", { command });
                return { kind: "defer" };
            case "recognized": {
                const innerCommand = classification.match.innerCommand;
                // Record the derived inner command so the engine's exception
                // log retains it if the re-evaluation below throws.
                evidence.innerCommand = innerCommand;
                if (isRecognizedWrapper(innerCommand)) {
                    log.debug("inner_cmd.nested_timeout", { command, innerCommand });
                    return { kind: "defer" };
                }
                const result = query.checkPermission(
                    BASH_SURFACE,
                    innerCommand,
                    details.agentName ?? undefined,
                );
                switch (result.state) {
                    case "allow":
                        log.review("inner_cmd.allow", { command, innerCommand });
                        return { kind: "allow" };
                    case "deny":
                        log.review("inner_cmd.deny", { command, innerCommand });
                        return { kind: "deny" };
                    case "ask":
                    default:
                        log.debug("inner_cmd.inner_ask", { command, innerCommand });
                        return { kind: "defer" };
                }
            }
        }
    },
};
