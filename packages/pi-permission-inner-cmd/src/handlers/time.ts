import {
    isRecognizedWrapper,
    parseTimeWrapper,
    TIME_PREFIX,
} from "../recognizer";
import { stripWrapperUnit } from "./strip";
import type { CommandHandler } from "./types";

/** Bash permission surface queried when re-evaluating the inner command. */
const BASH_SURFACE = "bash";

/**
 * The bare `time` wrapper handler (ADR 0009).
 *
 * `time <command>` — the Bash reserved-word timing form with no modifier
 * args — is transparent: it runs the inner command unchanged and only adds
 * timing. The wrapper is stripped from the FULL command and the whole
 * de-wrapped compound is re-evaluated, exactly like `timeout`, so sibling
 * commands (including dangerous ones) are still judged and cannot hide behind
 * the wrapper's allow.
 *
 * Unsupported time syntax (`time -p`, `time -- ls`, bare `time`), a nested
 * recognized wrapper (`time time cmd`, `time timeout 10 cmd`), a unit that
 * cannot be located exactly once in the full command, and any non-allowing
 * re-evaluation all defer fail-closed. `/usr/bin/time` by full path is not
 * claimed at all.
 */
export const timeHandler: CommandHandler = {
    id: "time",
    decide(ctx) {
        const {
            command: fullCommand,
            unit,
            details,
            query,
            log,
            evidence,
        } = ctx;

        const unitMatch = parseTimeWrapper(unit);
        if (unitMatch === undefined) {
            // Not the recognized form. If it still names `time`, surface it
            // as unsupported; otherwise this unit is not ours.
            if (TIME_PREFIX.test(unit)) {
                log.debug("inner_cmd.unsupported_wrapper_syntax", {
                    command: fullCommand,
                    wrapper: "time",
                });
                return { kind: "defer" };
            }
            return undefined;
        }

        const innerCommand = unitMatch.innerCommand;
        evidence.innerCommand = innerCommand;

        // Never unwrap into another recognized wrapper.
        if (isRecognizedWrapper(innerCommand)) {
            log.debug("inner_cmd.nested_wrapper", {
                command: fullCommand,
                innerCommand,
                wrapper: "time",
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
                // `requestId` joins this link decision to the gate's
                // permission_request.* entries for offline analysis.
                log.review("inner_cmd.allow", {
                    requestId: details.requestId,
                    command: fullCommand,
                    innerCommand,
                });
                return { kind: "allow" };
            case "deny":
                log.review("inner_cmd.deny", {
                    requestId: details.requestId,
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
