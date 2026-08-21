import { describe, expect, it } from "vitest";
import {
    buildConversationEvidence,
    type ConversationProbe,
} from "../src/evidence/conversation";

function entry(text: string): unknown {
    return {
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
    };
}
function assistantEntry(text: string): unknown {
    return {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }] },
    };
}
function compactionEntry(): unknown {
    return { type: "compaction", summary: "derived" };
}

describe("buildConversationEvidence — whitelist", () => {
    it("keeps only user text, excludes assistant and non-message entries", () => {
        const probe: ConversationProbe = {
            getActiveEntries: () => [
                entry("first user"),
                assistantEntry("assistant reasoning"),
                { type: "label", name: "x" },
                entry("second user"),
            ],
        };
        const evidence = buildConversationEvidence(probe);
        expect(evidence.items).toEqual([
            { position: 1, role: "user", text: "first user" },
            { position: 2, role: "user", text: "second user" },
        ]);
        expect(evidence.hasCompaction).toBe(false);
        expect(evidence.truncated).toBe(false);
        expect(evidence.renderedChars).toBe("first user".length + "second user".length);
    });

    it("accepts string message content", () => {
        const probe: ConversationProbe = {
            getActiveEntries: () => [
                {
                    type: "message",
                    message: { role: "user", content: "plain string" },
                },
            ],
        };
        expect(buildConversationEvidence(probe).items[0]?.text).toBe("plain string");
    });

    it("flags compaction presence without leaking summary text", () => {
        const probe: ConversationProbe = {
            getActiveEntries: () => [compactionEntry(), entry("after")],
        };
        const evidence = buildConversationEvidence(probe);
        expect(evidence.hasCompaction).toBe(true);
        expect(evidence.items).toHaveLength(1);
    });
});

describe("buildConversationEvidence — bounds", () => {
    it("keeps at most 16 items, newest window, and marks truncation", () => {
        const entries = Array.from({ length: 20 }, (_, i) => entry(`user-${i}`));
        const evidence = buildConversationEvidence({ getActiveEntries: () => entries });
        expect(evidence.items).toHaveLength(16);
        expect(evidence.truncated).toBe(true);
        expect(evidence.items[0]?.text).toBe("user-4");
        expect(evidence.items[15]?.text).toBe("user-19");
        expect(evidence.items[15]?.position).toBe(16);
    });

    it("preserves the latest user even when it alone exceeds the char budget", () => {
        const huge = "x".repeat(15_000);
        const evidence = buildConversationEvidence({
            getActiveEntries: () => [entry("small"), entry(huge)],
        });
        expect(evidence.items).toHaveLength(1);
        expect(evidence.items[0]?.text).toBe(huge);
        expect(evidence.truncated).toBe(true);
    });

    it("drops the oldest head when the character budget is exceeded", () => {
        const evidence = buildConversationEvidence({
            getActiveEntries: () => [
                entry("a".repeat(7_000)),
                entry("b".repeat(7_000)), // both would exceed 12,000
                entry("tail"),
            ],
        });
        expect(evidence.items.map((i) => i.text)).toEqual([
            "b".repeat(7_000),
            "tail",
        ]);
        expect(evidence.truncated).toBe(true);
        expect(evidence.renderedChars).toBeLessThanOrEqual(12_001);
    });

    it("returns empty evidence for an empty branch", () => {
        const evidence = buildConversationEvidence({ getActiveEntries: () => [] });
        expect(evidence).toEqual({
            items: [],
            hasCompaction: false,
            truncated: false,
            renderedChars: 0,
        });
    });
});
