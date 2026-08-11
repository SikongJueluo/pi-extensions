import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { recoverNativeBashCommand } from "../src/recovery";

/** Build a minimal assistant message entry carrying the given content blocks. */
function assistantEntry(content: unknown[], id = "entry-1"): SessionEntry {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        message: {
            role: "assistant",
            content,
        },
    } as unknown as SessionEntry;
}

/** A user message entry, to confirm non-assistant entries are ignored. */
function userEntry(): SessionEntry {
    return {
        type: "message",
        id: "entry-user",
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        message: { role: "user", content: "hello" },
    } as unknown as SessionEntry;
}

/** A tool-result message entry, ignored by recovery. */
function toolResultEntry(): SessionEntry {
    return {
        type: "message",
        id: "entry-tool-result",
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "bash",
            content: [],
            isError: false,
            timestamp: 0,
        },
    } as unknown as SessionEntry;
}

/** A non-message entry (compaction), ignored by recovery. */
function compactionEntry(): SessionEntry {
    return {
        type: "compaction",
        id: "entry-compaction",
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        summary: "...",
        firstKeptEntryId: "x",
        tokensBefore: 0,
    } as unknown as SessionEntry;
}

function toolCall(
    id: string,
    name: string,
    args: Record<string, unknown>,
): Record<string, unknown> {
    return { type: "toolCall", id, name, arguments: args };
}

function bashToolCall(id: string, command: unknown): Record<string, unknown> {
    return { type: "toolCall", id, name: "bash", arguments: { command } };
}

describe("recoverNativeBashCommand", () => {
    it("returns the command for a single native Bash tool call", () => {
        const entries = [
            userEntry(),
            assistantEntry([
                { type: "text", text: "running tests" },
                bashToolCall("call_1", "timeout 30s pnpm test"),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBe(
            "timeout 30s pnpm test",
        );
    });

    it("finds the matching tool call among several with different ids", () => {
        const entries = [
            assistantEntry([
                bashToolCall("call_a", "pnpm build"),
                bashToolCall("call_b", "timeout 30s pnpm test"),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_b")).toBe(
            "timeout 30s pnpm test",
        );
    });

    it("ignores user, tool-result, and non-message entries", () => {
        const entries = [
            compactionEntry(),
            userEntry(),
            toolResultEntry(),
            assistantEntry([bashToolCall("call_1", "echo hi")]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBe("echo hi");
    });

    it("returns undefined when no tool call matches the id", () => {
        const entries = [assistantEntry([bashToolCall("call_1", "echo hi")])];
        expect(recoverNativeBashCommand(entries, "call_missing")).toBeUndefined();
    });

    it("returns undefined on a duplicate id (cannot prove authority)", () => {
        const entries = [
            assistantEntry([
                bashToolCall("call_1", "timeout 30s pnpm test"),
                bashToolCall("call_1", "timeout 30s rm -rf /"),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBeUndefined();
    });

    it("returns undefined when the only match is a non-Bash tool", () => {
        const entries = [
            assistantEntry([
                toolCall("call_1", "read", { path: "/etc/passwd" }),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBeUndefined();
    });

    it("returns undefined when arguments.command is not a string", () => {
        const entries = [
            assistantEntry([bashToolCall("call_1", 12345)]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBeUndefined();
    });

    it("returns undefined when arguments.command is missing", () => {
        const entries = [
            assistantEntry([
                toolCall("call_1", "bash", { timeout: 30 }),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBeUndefined();
    });

    it("returns undefined for a duplicate id even when the first match is invalid", () => {
        const entries = [
            assistantEntry([
                toolCall("call_1", "read", { path: "/a" }),
                bashToolCall("call_1", "timeout 30s pnpm test"),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBeUndefined();
    });

    it("returns the latest command when the id recurs across messages", () => {
        // A cross-message id reuse resolves to the latest block, which is the
        // call currently being authorized; the earlier block is already-
        // resolved history and must not fail-closed the recovery.
        const entries = [
            assistantEntry(
                [bashToolCall("call_1", "timeout 30s rm -rf /")],
                "entry-a",
            ),
            assistantEntry(
                [bashToolCall("call_1", "timeout 30s pnpm test")],
                "entry-b",
            ),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBe(
            "timeout 30s pnpm test",
        );
    });

    it("tolerates a malformed content block that is not a tool call", () => {
        const entries = [
            assistantEntry([
                { type: "text", text: "thinking..." },
                null,
                { type: "thinking", thinking: "..." },
                bashToolCall("call_1", "timeout 30s pnpm test"),
            ]),
        ];
        expect(recoverNativeBashCommand(entries, "call_1")).toBe(
            "timeout 30s pnpm test",
        );
    });
});
