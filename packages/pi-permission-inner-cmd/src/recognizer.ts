/**
 * Wrapper recognizers (ADRs 0001 and 0009).
 *
 * Two transparent wrappers are recognized in their strict bare forms:
 * `timeout <duration> <command>` (ADR 0001) and `time <command>` (ADR 0009,
 * the Bash reserved-word timing form with no modifier args). Every other
 * invocation of either program is left to the next authority.
 */

/**
 * Matches `timeout <duration> <command>` where `<duration>` follows GNU
 * timeout's grammar: a positive number (integer or decimal, no leading zero)
 * with an optional unit `s`/`m`/`h`/`d` (default seconds). A bare integer such
 * as `timeout 240 cmd` is therefore accepted (240 seconds).
 *
 * The duration format is irrelevant to unwrap soundness — the duration is
 * discarded and only the inner command is re-evaluated — so GNU's full numeric
 * grammar is accepted. Still excluded: `0`/leading-zero durations, `ms` (not a
 * timeout unit), multi-letter units, and flags (`-k`, `--preserve-status`, GNU
 * `--`), so a wrapper that cannot be re-evaluated safely is never unwrapped.
 */
const TIMEOUT_WRAPPER_PATTERN =
    /^timeout[ \t]+([1-9][0-9]*(?:\.[0-9]+)?[smhd]?)[ \t]+(.+)$/;

/**
 * Matches `time <command>` — the bare timing wrapper with no modifier args.
 * A dash immediately after the separator (any amount of whitespace) means
 * modifier args are present (`time -p ls`, `time -- ls`, or a `/usr/bin/time`
 * flag such as `-o FILE`, which writes a file). Those can change what the
 * wrapper does beyond timing, so the form is not recognized and never
 * unwrapped. The lookahead also rejects a whitespace-only remainder, so
 * regex backtracking cannot smuggle a leading space into the inner command.
 */
const TIME_WRAPPER_PATTERN = /^time[ \t]+(?![-\s])(.+)$/;

/** A command that begins with the bare `timeout` wrapper program. */
export const TIMEOUT_PREFIX = /^timeout(?:[ \t]|$)/;

/**
 * A command that begins with the word `time` — the Bash reserved word or the
 * `/usr/bin/time`-style binary invoked by bare name. Full-path invocations
 * (`/usr/bin/time cmd`) do not match and are not claimed by any handler.
 */
export const TIME_PREFIX = /^time(?:[ \t]|$)/;

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

export interface TimeWrapperMatch {
    readonly innerCommand: string;
}

/**
 * Parse a command as the bare `time` wrapper (ADR 0009).
 *
 * @returns the full inner command (including any `&&`/`;`/`|` siblings), or
 * `undefined` when the command is not the recognized bare `time <command>`
 * form.
 */
export function parseTimeWrapper(
    command: string,
): TimeWrapperMatch | undefined {
    const match = TIME_WRAPPER_PATTERN.exec(command);
    if (match === null) {
        return undefined;
    }
    return { innerCommand: match[1] };
}

/**
 * Whether a command is itself a recognized wrapper (timeout or time, in their
 * strict bare forms). Used to reject nested wrappers so at most one level is
 * ever unwrapped.
 */
export function isRecognizedWrapper(command: string): boolean {
    return (
        parseTimeoutWrapper(command) !== undefined ||
        parseTimeWrapper(command) !== undefined
    );
}

/**
 * A recognized wrapper, tagged with which grammar recognized it.
 *
 * The `wrapper` discriminator tells consumers which `match` shape applies
 * without a union-widening cast.
 */
export type RecognizedWrapper =
    | { readonly wrapper: "timeout"; readonly match: TimeoutWrapperMatch }
    | { readonly wrapper: "time"; readonly match: TimeWrapperMatch };

/** How a complete Bash command relates to the recognizers. */
export type WrapperClassification =
    | ({ readonly kind: "recognized" } & RecognizedWrapper)
    | { readonly kind: "unsupported"; readonly wrapper: "timeout" | "time" }
    | { readonly kind: "other" };

/**
 * Classify a complete Bash command against the recognizers.
 *
 * - `recognized`: one of the strict bare wrapper forms.
 * - `unsupported`: the command invokes `timeout` or `time` but is not the
 *   recognized strict form (flags, `-k`, missing command, ...). These are
 *   logged at debug so an operator can see why a wrapper was skipped.
 * - `other`: an ordinary command this authorizer does not handle. These defer
 *   silently.
 */
export function classifyWrapper(command: string): WrapperClassification {
    const timeoutMatch = parseTimeoutWrapper(command);
    if (timeoutMatch !== undefined) {
        return { kind: "recognized", wrapper: "timeout", match: timeoutMatch };
    }
    const timeMatch = parseTimeWrapper(command);
    if (timeMatch !== undefined) {
        return { kind: "recognized", wrapper: "time", match: timeMatch };
    }
    if (TIMEOUT_PREFIX.test(command)) {
        return { kind: "unsupported", wrapper: "timeout" };
    }
    if (TIME_PREFIX.test(command)) {
        return { kind: "unsupported", wrapper: "time" };
    }
    return { kind: "other" };
}
