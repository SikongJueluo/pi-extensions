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
 * Walks session entries, finds the assistant `toolCall` block whose `id` equals
 * `toolCallId`, and reads its structured `arguments.command`. Proceeds only
 * when, per ADR 0001:
 *
 * - exactly one block matches the id (no duplicate),
 * - that block names the native Bash tool,
 * - `arguments.command` is a string.
 *
 * Any other outcome — no match, duplicate id, a non-Bash tool call, a
 * non-string command, or malformed entries — returns `undefined` so the caller
 * defers fail-closed.
 *
 * @returns the complete Bash command, or `undefined`.
 */
export function recoverNativeBashCommand(
    entries: ReadonlyArray<SessionEntry>,
    toolCallId: string,
): string | undefined {
    let matches = 0;
    let command: string | undefined;

    for (const entry of entries) {
        if (entry.type !== "message") {
            continue;
        }
        const message = entry.message as { role?: unknown; content?: unknown };
        if (message.role !== "assistant") {
            continue;
        }
        const content = message.content;
        if (!Array.isArray(content)) {
            continue;
        }
        for (const block of content) {
            if (!isToolCallBlock(block) || block.id !== toolCallId) {
                continue;
            }
            matches += 1;
            // Keep walking the whole session so a duplicate id (two matching
            // blocks) is detected even when the first match was unusable.
            if (matches === 1) {
                command = extractBashCommand(block);
            }
        }
    }

    return matches === 1 ? command : undefined;
}
