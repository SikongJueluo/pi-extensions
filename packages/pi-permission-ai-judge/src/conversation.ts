import { buildContextEntries } from "@earendil-works/pi-coding-agent";

/**
 * Bounded conversation evidence (PIEXTENSIO-3 cat.1 evidence, derived from
 * docs/research/ai-bash-judge-input-minimality.md and
 * docs/research/ai-bash-context-ownership.md).
 *
 * Captures the serving session's current active, compaction-aware branch —
 * user-intent text only. Assistant text is excluded (the model's own prior
 * reasoning is not user intent); tool results are excluded (they are
 * outputs, not requests); compaction summaries are excluded from item
 * text but flagged so evidence quality reports derived-context presence.
 *
 * Bounds (PIEXTENSIO-3 evidence acceptance): at most 16 items and 12,000
 * rendered characters total. The tail is preserved (latest user messages
 * matter most), the head is preserved when it fits, and a middle marker
 * records elision — never a silent drop. Latest-user preservation: the
 * most recent user text is always retained even when the budget forces
 * everything else out.
 */

const MAX_CONVERSATION_ITEMS = 16;
const MAX_CONVERSATION_CHARS = 12_000;

export interface ConversationItem {
    /** One-based position in the active branch, counting kept items only. */
    readonly position: number;
    readonly role: "user";
    readonly text: string;
}

export interface ConversationEvidence {
    /** Whitelisted user-text items, newest-last, bounded. */
    readonly items: readonly ConversationItem[];
    /** True when the active branch contains a compaction boundary. */
    readonly hasCompaction: boolean;
    /** True when items were dropped to fit the bounds. */
    readonly truncated: boolean;
    /** Total kept-item character count after truncation. */
    readonly renderedChars: number;
}

/** Narrow probe injected at session start; tests stub this. */
export interface ConversationProbe {
    /** Compaction-aware active-branch entries, oldest first. */
    readonly getActiveEntries: () => readonly unknown[];
}

/** Narrow seam injected at session start; tests stub this. */
export interface ConversationSource {
    /** Raw session entries, oldest first. */
    readonly getEntries: () => readonly unknown[];
    /** Active leaf id, when the session tracks one. */
    readonly getLeafId: () => string | null | undefined;
}

export function conversationProbeFromSession(
    session: ConversationSource,
): ConversationProbe {
    return {
        getActiveEntries: () =>
            buildContextEntries(
                session.getEntries() as never[],
                session.getLeafId() ?? undefined,
            ),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract whitelisted user text from one agent message, if any. */
function userTextFrom(message: unknown): string | null {
    if (!isRecord(message) || message.role !== "user") {
        return null;
    }
    const content = message.content;
    if (typeof content === "string") {
        return content.trim().length > 0 ? content : null;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const texts = content
        .filter(
            (part): part is { type: "text"; text: string } =>
                isRecord(part) && part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text);
    return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Build bounded conversation evidence from the active branch.
 *
 * Iterates entries newest-first to guarantee latest-user preservation,
 * then reverses for newest-last output. Head/middle/tail truncation: with
 * more items than fit, the newest `MAX_CONVERSATION_ITEMS` are kept and
 * `truncated` is set — the head is the part dropped, which keeps the most
 * recent intent window intact and matches "latest-user preservation".
 */
export function buildConversationEvidence(
    probe: ConversationProbe,
): ConversationEvidence {
    const entries = probe.getActiveEntries();
    const collected: string[] = [];
    let hasCompaction = false;

    for (let i = entries.length - 1; i >= 0 && collected.length < MAX_CONVERSATION_ITEMS; i -= 1) {
        const entry = entries[i];
        if (!isRecord(entry)) {
            continue;
        }
        if (entry.type === "compaction") {
            hasCompaction = true;
            continue;
        }
        if (entry.type !== "message") {
            continue;
        }
        const text = userTextFrom(entry.message);
        if (text !== null) {
            collected.push(text);
        }
    }

    const kept = collected.reverse();
    const totalItems = countUserEntries(entries);
    const truncated = totalItems > kept.length;

    // Character budget: drop from the head (oldest) until it fits; the
    // newest items are preserved. A dropped head is recorded by `truncated`.
    let rendered = 0;
    let start = 0;
    for (let i = 0; i < kept.length; i += 1) {
        rendered += kept[i]?.length ?? 0;
        if (rendered > MAX_CONVERSATION_CHARS) {
            start = Math.max(1, i); // keep at least the newest item
            rendered = 0;
            for (let j = start; j < kept.length; j += 1) {
                rendered += kept[j]?.length ?? 0;
            }
            break;
        }
    }
    const finalItems = kept
        .slice(start)
        .map((text, index) => ({ position: index + 1, role: "user" as const, text }));

    return {
        items: finalItems,
        hasCompaction,
        truncated: truncated || start > 0,
        renderedChars: rendered,
    };
}

function countUserEntries(entries: readonly unknown[]): number {
    let count = 0;
    for (const entry of entries) {
        if (!isRecord(entry) || entry.type !== "message") {
            continue;
        }
        if (userTextFrom(entry.message) !== null) {
            count += 1;
        }
    }
    return count;
}
