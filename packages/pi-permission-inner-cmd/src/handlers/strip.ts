/**
 * Shared helper for the transparent unwrap handlers (`timeout`, `time`).
 */

/**
 * Replace the wrapper unit with its unwrapped inner inside the full command,
 * exactly once. Returns `undefined` when the unit is not a unique substring
 * (absent, or appears more than once), so the caller defers fail-closed rather
 * than guess where to strip.
 */
export function stripWrapperUnit(
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
