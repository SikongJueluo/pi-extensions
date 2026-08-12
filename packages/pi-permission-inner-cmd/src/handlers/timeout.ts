import {
    isRecognizedWrapper,
    parseTimeoutWrapper,
    TIMEOUT_PREFIX,
} from "../recognizer";
import type { CommandHandler } from "./types";

/** Bash permission surface queried when re-evaluating the inner command. */
const BASH_SURFACE = "bash";

/**
 * Replace the wrapper unit with its unwrapped inner inside the full command,
 * exactly once. Returns `undefined` when the unit is not a unique substring
 * (absent, or appears more than once), so the caller defers fail-closed rather
 * than guess where to strip.
 */
function stripWrapperUnit(
    fullCommand: string,
    unit: string,
    inner: string,
): string | undefined {
    const first = fullCommand.indexOf(unit);
    if (first === -1) {
        return undefined;
    }
    if (fullCommand.indexOf(unit, first + unit.length) !== -1) {
        return undefined;
    }
    return (
        fullCommand.slice(0, first) +
        inner +
        fullCommand.slice(first + unit.length)
    );
}

/**
 * The simple-timeout wrapper handler (ADR 0001).
 *
 * Detection runs on `details.command` — the command unit the permission system
 * isolated as the ask trigger — which is always wrapper-leading even when the
 * full recovered command is a scaffold that starts with `cd`/`echo`/…. The
 * wrapper is then stripped from the FULL command and the whole de-wrapped
 * compound is re-evaluated, so sibling commands (including dangerous ones) are
 * still judged and cannot hide behind the wrapper's allow.
 *
 * Unsupported timeout syntax, a nested wrapper, a unit that cannot be located
 * exactly once in the full command, and any non-allowing re-evaluation all
 * defer fail-closed.
 */
export const timeoutHandler: CommandHandler = {
    id: "timeout",
    decide(ctx) {
        const { command: fullCommand, details, query, log, evidence } = ctx;
        const unit = details.command;
        if (unit === undefined) {
            return undefined;
        }

        const unitMatch = parseTimeoutWrapper(unit);
        if (unitMatch === undefined) {
            // Not the recognized form. If it still names `timeout`, surface it
            // as unsupported; otherwise this unit is not ours.
            if (TIMEOUT_PREFIX.test(unit)) {
                log.debug("inner_cmd.unsupported_timeout_syntax", {
                    command: fullCommand,
                });
                return { kind: "defer" };
            }
            return undefined;
        }

        const innerCommand = unitMatch.innerCommand;
        evidence.innerCommand = innerCommand;

        // Never unwrap into another wrapper.
        if (isRecognizedWrapper(innerCommand)) {
            log.debug("inner_cmd.nested_timeout", {
                command: fullCommand,
                innerCommand,
            });
            return { kind: "defer" };
        }

        // Strip the wrapper from the full command (handles scaffolds). Defer
        // fail-closed if the unit is not a unique substring.
        const unwrappedFull = stripWrapperUnit(
            fullCommand,
            unit,
            innerCommand,
        );
        if (unwrappedFull === undefined) {
            log.debug("inner_cmd.wrapper_not_located", {
                command: fullCommand,
            });
            return { kind: "defer" };
        }

        // Authoritative: re-evaluate the full de-wrapped compound. The
        // permission system decomposes it into units and keeps the most
        // restrictive, so any non-allowing sibling defers here.
        const result = query.checkPermission(
            BASH_SURFACE,
            unwrappedFull,
            details.agentName ?? undefined,
        );
        switch (result.state) {
            case "allow":
                log.review("inner_cmd.allow", {
                    command: fullCommand,
                    innerCommand,
                });
                return { kind: "allow" };
            case "deny":
                log.review("inner_cmd.deny", {
                    command: fullCommand,
                    innerCommand,
                });
                return { kind: "deny" };
            case "ask":
            default:
                log.debug("inner_cmd.inner_ask", {
                    command: fullCommand,
                    innerCommand,
                });
                return { kind: "defer" };
        }
    },
};
