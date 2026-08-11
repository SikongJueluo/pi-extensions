import type { CommandHandler } from "./types";

/** Matches a command whose leading program is `xargs`. */
const XARGS_PREFIX = /^xargs(?:[ \t]|$)/;

/**
 * The `xargs` wrapper handler (ADR 0003).
 *
 * `xargs` is non-transparent in a way distinct from `env`: the inner command's
 * name is known, but its arguments are read from stdin (or `-a FILE`) at run
 * time, so they are absent from the command string entirely. Re-evaluating the
 * inner command is unsound — the verdict would apply to arguments that are not
 * even knowable from the input. `xargs` is claimed but always deferred; it
 * never unwraps. (`xargs` usually appears mid-pipeline, so inner-cmd's
 * leading-program check rarely reaches it; this handler covers the rarer
 * `xargs`-as-leading-program case for observability.)
 */
export const xargsHandler: CommandHandler = {
    id: "xargs",
    decide({ command, log }) {
        if (!XARGS_PREFIX.test(command)) {
            return undefined;
        }
        log.debug("inner_cmd.xargs_non_transparent", { command });
        return { kind: "defer" };
    },
};
