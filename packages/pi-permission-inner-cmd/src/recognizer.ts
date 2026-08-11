/**
 * V0.1 wrapper recognizer.
 *
 * The strict simple-timeout grammar from ADR 0001. V0.1 unwraps exactly
 * `timeout <duration> <command>`; every other `timeout` invocation is left to
 * the next authority.
 */

/**
 * Matches `timeout <duration> <command>` where `<duration>` is a positive
 * integer (no leading zero) followed by a single unit `s`/`m`/`h`/`d`.
 *
 * Flags (`-k`, `--preserve-status`, GNU `--`), compound durations, and the
 * bare form are intentionally excluded so v0.1 never unwraps a wrapper it
 * cannot re-evaluate safely.
 */
const TIMEOUT_WRAPPER_PATTERN = /^timeout[ \t]+([1-9][0-9]*[smhd])[ \t]+(.+)$/;

/** A command that begins with the bare `timeout` wrapper program. */
const TIMEOUT_PREFIX = /^timeout(?:[ \t]|$)/;

export interface TimeoutWrapperMatch {
    readonly duration: string;
    readonly innerCommand: string;
}

/**
 * Parse a command as the strict simple-timeout wrapper.
 *
 * @returns the duration token and the full inner command (including any
 * `&&`/`;`/`|` siblings), or `undefined` when the command is not the
 * recognized `timeout <duration> <command>` form.
 */
export function parseTimeoutWrapper(
    command: string,
): TimeoutWrapperMatch | undefined {
    const match = TIMEOUT_WRAPPER_PATTERN.exec(command);
    if (match === null) {
        return undefined;
    }
    return {
        duration: match[1],
        innerCommand: match[2],
    };
}

/**
 * Whether a command is itself a recognized wrapper. Used to reject nested
 * wrappers so v0.1 unwraps at most one level.
 */
export function isRecognizedWrapper(command: string): boolean {
    return parseTimeoutWrapper(command) !== undefined;
}

/** How a recovered Bash command relates to the v0.1 recognizer. */
export type WrapperClassification =
    | { readonly kind: "recognized"; readonly match: TimeoutWrapperMatch }
    | { readonly kind: "unsupportedTimeout" }
    | { readonly kind: "nonTimeout" };

/**
 * Classify a recovered Bash command against the v0.1 recognizer.
 *
 * - `recognized`: the strict simple-timeout wrapper.
 * - `unsupportedTimeout`: the command invokes `timeout` but is not the
 *   recognized strict form (flags, `-k`, missing command, ...). These are
 *   logged at debug so an operator can see why a wrapper was skipped.
 * - `nonTimeout`: an ordinary command this authorizer does not handle. These
 *   defer silently.
 */
export function classifyWrapper(command: string): WrapperClassification {
    const match = parseTimeoutWrapper(command);
    if (match !== undefined) {
        return { kind: "recognized", match };
    }
    if (TIMEOUT_PREFIX.test(command)) {
        return { kind: "unsupportedTimeout" };
    }
    return { kind: "nonTimeout" };
}
