import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Name of Pi's native Bash tool, as recorded in a tool-call block. */
export const NATIVE_BASH_TOOL_NAME = "bash";

/** A structurally-validated tool-call content block. */
interface ToolCallBlock {
    readonly id: string;
    readonly name: unknown;
    readonly arguments: unknown;
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
    return (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall" &&
        typeof (block as { id?: unknown }).id === "string"
    );
}

/** Read the native Bash command off a single validated tool-call block. */
function extractBashCommand(block: ToolCallBlock): string | undefined {
    if (block.name !== NATIVE_BASH_TOOL_NAME) {
        return undefined;
    }
    const command = (
        block.arguments as { command?: unknown } | null | undefined
    )?.command;
    return typeof command === "string" ? command : undefined;
}

/**
 * Recover the complete native Bash command for one tool call.
 *
 * The tool call being authorized is always the most recent one, so entries are
 * walked in reverse and the search stops at the first (latest) assistant
 * message that contains a `toolCall` block whose `id` equals `toolCallId`.
 *
 * Per ADR 0001, the id must match exactly one block *within that single
 * message*. An earlier message reusing the same id is a stale, already-resolved
 * call and is irrelevant to the current authorization; but two matching blocks
 * inside one message cannot be disambiguated (we cannot tell which one
 * `details.toolCallId` refers to), so that case stays fail-closed. The matched
 * block must then name the native Bash tool and carry a string
 * `arguments.command`.
 *
 * Any other outcome — no match, a within-message duplicate id, a non-Bash tool
 * call, a non-string command, or malformed entries — returns `undefined` so the
 * caller defers fail-closed.
 *
 * @returns the complete Bash command, or `undefined`.
 */
export function recoverNativeBashCommand(
    entries: ReadonlyArray<SessionEntry>,
    toolCallId: string,
): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message") {
            continue;
        }
        const message = entry.message;
        if (message.role !== "assistant") {
            continue;
        }

        const matches: ToolCallBlock[] = [];
        for (const block of message.content) {
            if (isToolCallBlock(block) && block.id === toolCallId) {
                matches.push(block);
            }
        }

        if (matches.length === 0) {
            continue;
        }

        // Latest message containing the id. Uniqueness only has to hold within
        // this one message (see above); a cross-message reuse resolves to the
        // latest, which is the call currently being authorized.
        return matches.length === 1
            ? extractBashCommand(matches[0])
            : undefined;
    }

    return undefined;
}
