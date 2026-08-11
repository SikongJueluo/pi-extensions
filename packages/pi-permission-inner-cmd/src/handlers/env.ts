import type { CommandHandler } from "./types";

/** Matches a command whose leading program is `env`. */
const ENV_PREFIX = /^env(?:[ \t]|$)/;

/**
 * The `env` wrapper handler.
 *
 * `env` is non-transparent: its modifier args (`NAME=VALUE`, `-i`, `-u`) can
 * change which binary the inner command resolves to (e.g. a `PATH=` override),
 * so stripping them and re-evaluating the inner command is unsound. `env` is
 * therefore claimed but always deferred — it never unwraps. Commands not
 * starting with `env` return `undefined` so the engine can try the next
 * handler.
 */
export const envHandler: CommandHandler = {
    id: "env",
    decide({ command, log }) {
        if (!ENV_PREFIX.test(command)) {
            return undefined;
        }
        log.debug("inner_cmd.env_non_transparent", { command });
        return { kind: "defer" };
    },
};
