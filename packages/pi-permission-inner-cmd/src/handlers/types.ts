import type {
    AuthorizerLog,
    AuthorizerVerdict,
    PermissionQuery,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

/** Context handed to a handler for one structured Bash ask. */
export interface HandlerContext {
    /** The complete Bash tool input from the permission payload. */
    readonly command: string;
    /** The command unit whose deterministic rule produced the ask. */
    readonly unit: string;
    readonly details: PromptPermissionDetails;
    readonly query: PermissionQuery;
    readonly log: AuthorizerLog;
    /**
     * Partial-result bag. A handler that recognizes the command records derived
     * values here (e.g. `ctx.evidence.innerCommand = innerCommand`) so the
     * engine's exception log retains them if `decide` later throws. The engine
     * resets this bag per handler.
     */
    readonly evidence: Record<string, unknown>;
}

/**
 * A self-contained verdict strategy for one kind of Bash command.
 *
 * The engine walks registered handlers in order; the first that returns a
 * verdict claims the command. Returning `undefined` means "not mine" and lets
 * the engine try the next handler.
 */
export interface CommandHandler {
    /** Stable id for logs, e.g. "timeout". */
    readonly id: string;
    /**
     * Inspect the command: return a verdict to claim it (the engine stops), or
     * `undefined` to pass to the next handler.
     */
    decide(ctx: HandlerContext): AuthorizerVerdict | undefined;
}
