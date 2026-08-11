import { envHandler } from "./env";
import { timeoutHandler } from "./timeout";
import { xargsHandler } from "./xargs";
import type { CommandHandler } from "./types";

/**
 * Registered command handlers, tried in order. The first to return a verdict
 * claims the command; the rest are not consulted. Add a handler here (and a
 * new file under `handlers/`) to support a new command type.
 */
export const handlers: readonly CommandHandler[] = [
    timeoutHandler,
    envHandler,
    xargsHandler,
];
