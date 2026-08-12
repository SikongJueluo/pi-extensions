import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
    AuthorizerLog,
    PermissionCheckResult,
    PermissionQuery,
    PermissionState,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { authorizeInnerCommand, type SessionProbe } from "../src/authorizer";

/** Default captured root-session identity used by the harness. */
const ROOT_SESSION_ID = "session-root";

type LogCall = {
    level: "review" | "debug";
    event: string;
    details?: Record<string, unknown>;
};

function makeLog(): { log: AuthorizerLog; calls: LogCall[] } {
    const calls: LogCall[] = [];
    const log: AuthorizerLog = {
        review: (event, details) => calls.push({ level: "review", event, details }),
        debug: (event, details) => calls.push({ level: "debug", event, details }),
    };
    return { log, calls };
}

type CheckCall = {
    surface: string;
    value: string | undefined;
    agentName: string | undefined;
};

function makeQuery(
    states: Record<string, PermissionState>,
    opts: { throwOn?: string } = {},
): { query: PermissionQuery; calls: CheckCall[] } {
    const calls: CheckCall[] = [];
    const query: PermissionQuery = {
        checkPermission: (surface, value, agentName) => {
            calls.push({ surface, value, agentName });
            if (opts.throwOn !== undefined && value === opts.throwOn) {
                throw new Error("policy boom");
            }
            const state: PermissionState = states[value ?? ""] ?? "ask";
            const result: PermissionCheckResult = {
                toolName: "bash",
                state,
                source: "bash",
                origin: "builtin",
            };
            return result;
        },
        getToolPermission: () => "ask",
    };
    return { query, calls };
}

function assistantEntry(content: unknown[]): SessionEntry {
    return {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        message: { role: "assistant", content },
    } as unknown as SessionEntry;
}

function bashToolCall(id: string, command: unknown): Record<string, unknown> {
    return { type: "toolCall", id, name: "bash", arguments: { command } };
}

function entriesRecovering(command: string, toolCallId = "call_1"): SessionEntry[] {
    return [assistantEntry([bashToolCall(toolCallId, command)])];
}

function bashDetails(
    toolCallId = "call_1",
    agentName: string | null = null,
    command?: string,
): PromptPermissionDetails {
    return {
        requestId: "req-1",
        source: "tool_call",
        agentName,
        message: "May I run bash?",
        toolCallId,
        toolName: "bash",
        // details.command is the winning unit the permission system isolated.
        command,
    };
}

function makeSessionProbe(args: {
    recoveredCommand: string;
    toolCallId: string;
    getEntriesThrows?: boolean;
    /** Live session id reported at authorize time. */
    sessionId?: string;
    getSessionIdThrows?: boolean;
}): SessionProbe {
    return {
        getEntries: args.getEntriesThrows
            ? (): SessionEntry[] => {
                throw new Error("session boom");
            }
            : (): SessionEntry[] =>
                entriesRecovering(args.recoveredCommand, args.toolCallId),
        getSessionId: args.getSessionIdThrows
            ? (): string => {
                throw new Error("session id boom");
            }
            : (): string => args.sessionId ?? ROOT_SESSION_ID,
    };
}

async function run(args: {
    recoveredCommand: string;
    /** details.command — the ask-triggering unit; defaults to recoveredCommand. */
    unitCommand?: string;
    states?: Record<string, PermissionState>;
    details?: Partial<PromptPermissionDetails>;
    getEntriesThrows?: boolean;
    queryThrowsOn?: string;
    /** Live session id diverges from the captured provenance. */
    sessionMismatch?: boolean;
    getSessionIdThrows?: boolean;
}): Promise<{
    verdict: { kind: string };
    log: LogCall[];
    check: CheckCall[];
}> {
    const { log, calls } = makeLog();
    const toolCallId = args.details?.toolCallId ?? "call_1";
    const { query, calls: check } = makeQuery(args.states ?? {}, {
        throwOn: args.queryThrowsOn,
    });
    const session = makeSessionProbe({
        recoveredCommand: args.recoveredCommand,
        toolCallId,
        getEntriesThrows: args.getEntriesThrows,
        getSessionIdThrows: args.getSessionIdThrows,
        sessionId: args.sessionMismatch ? "session-changed" : ROOT_SESSION_ID,
    });
    const unitCommand = args.unitCommand ?? args.recoveredCommand;
    const verdict = await authorizeInnerCommand({
        details: {
            ...bashDetails(toolCallId, null, unitCommand),
            ...args.details,
        } as PromptPermissionDetails,
        query,
        log,
        session,
        expectedSessionId: ROOT_SESSION_ID,
    });
    return { verdict: { kind: verdict.kind }, log: calls, check };
}

describe("authorizeInnerCommand — recognized wrapper verdicts", () => {
    it("maps an inner allow to allow and records a review", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
        });
        expect(verdict.kind).toBe("allow");
        expect(log).toEqual([
            {
                level: "review",
                event: "inner_cmd.allow",
                details: {
                    command: "timeout 30s pnpm test",
                    innerCommand: "pnpm test",
                },
            },
        ]);
        expect(check).toEqual([
            { surface: "bash", value: "pnpm test", agentName: undefined },
        ]);
    });

    it("maps an inner ask to defer and records a debug", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s git push",
            states: { "git push": "ask" },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.inner_ask",
                details: {
                    command: "timeout 30s git push",
                    innerCommand: "git push",
                },
            },
        ]);
    });

    it("maps an inner deny to deny and records a review", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s rm -rf /",
            states: { "rm -rf /": "deny" },
        });
        expect(verdict.kind).toBe("deny");
        expect(log).toEqual([
            {
                level: "review",
                event: "inner_cmd.deny",
                details: {
                    command: "timeout 30s rm -rf /",
                    innerCommand: "rm -rf /",
                },
            },
        ]);
    });

    it("re-checks the complete inner program for compound input", async () => {
        // timeout 60s pnpm test && git push -> inner "pnpm test && git push".
        // The whole program must be re-evaluated; git push asking defers it.
        const { verdict, log, check } = await run({
            recoveredCommand: "timeout 60s pnpm test && git push",
            states: { "pnpm test && git push": "ask" },
        });
        expect(verdict.kind).toBe("defer");
        expect(check).toEqual([
            {
                surface: "bash",
                value: "pnpm test && git push",
                agentName: undefined,
            },
        ]);
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.inner_ask",
                details: {
                    command: "timeout 60s pnpm test && git push",
                    innerCommand: "pnpm test && git push",
                },
            },
        ]);
    });

    it("unwraps timeout around bash -c and re-evaluates the inner program", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "timeout 30s bash -c something",
            states: { "bash -c something": "ask" },
        });
        expect(verdict.kind).toBe("defer");
        expect(check).toEqual([
            { surface: "bash", value: "bash -c something", agentName: undefined },
        ]);
        expect(log[0]?.event).toBe("inner_cmd.inner_ask");
    });

    it("forwards details.agentName ?? undefined into the inner query", async () => {
        const { check } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            details: { agentName: "release-worker" },
        });
        expect(check).toEqual([
            { surface: "bash", value: "pnpm test", agentName: "release-worker" },
        ]);
    });

    it("passes undefined when details.agentName is null", async () => {
        const { check } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            details: { agentName: null },
        });
        expect(check[0]?.agentName).toBeUndefined();
    });
});

describe("authorizeInnerCommand — root-ownership revalidation", () => {
    it("defers fail-closed when the live session id no longer matches", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            sessionMismatch: true,
        });
        expect(verdict.kind).toBe("defer");
        // Never reaches recovery or the decisive deterministic query.
        expect(check).toEqual([]);
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.session_mismatch",
                details: {
                    expectedSessionId: ROOT_SESSION_ID,
                    currentSessionId: "session-changed",
                },
            },
        ]);
    });

    it("still defers a forwarded ask before revalidating ownership", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            sessionMismatch: true,
            details: {
                forwarding: { requesterAgentName: "child", requesterSessionId: "s1" },
            },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]); // forwarded defers silently, before any session read
    });
});

describe("authorizeInnerCommand — fail-closed deferrals", () => {
    it("defers on unsupported timeout syntax with a debug log", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout -k 5s 30s pnpm test",
            states: { "pnpm test": "allow" },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.unsupported_timeout_syntax",
                details: { command: "timeout -k 5s 30s pnpm test" },
            },
        ]);
    });

    it("defers on a nested wrapper with a debug log", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "timeout 30s timeout 10s pnpm test",
            states: { "timeout 10s pnpm test": "allow" },
        });
        expect(verdict.kind).toBe("defer");
        expect(check).toEqual([]); // inner program is never re-evaluated
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.nested_timeout",
                details: {
                    command: "timeout 30s timeout 10s pnpm test",
                    innerCommand: "timeout 10s pnpm test",
                },
            },
        ]);
    });

    it("defers silently on an ordinary non-timeout command", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "pnpm test",
            states: { "pnpm test": "allow" },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]);
    });

    it("defers silently on a forwarded request", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            details: {
                forwarding: { requesterAgentName: "child", requesterSessionId: "s1" },
            },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]);
        expect(check).toEqual([]); // never reaches the deterministic query
    });

    it("defers silently for a non-Bash tool", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            details: { toolName: "read" },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]);
    });

    it("defers silently when toolCallId is absent", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            details: { toolCallId: undefined },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]);
    });

    it("defers silently when the tool call is not in the session", async () => {
        // Recover a command under a different id so recovery misses.
        const { log, calls } = makeLog();
        const { query, calls: check } = makeQuery({ "pnpm test": "allow" });
        const verdict = await authorizeInnerCommand({
            details: bashDetails("call_missing"),
            query,
            log,
            session: makeSessionProbe({
                recoveredCommand: "timeout 30s pnpm test",
                toolCallId: "call_1",
            }),
            expectedSessionId: ROOT_SESSION_ID,
        });
        expect(verdict.kind).toBe("defer");
        expect(calls).toEqual([]);
        expect(check).toEqual([]);
    });
});

describe("authorizeInnerCommand — env wrapper", () => {
    it("defers on an env wrapper with a debug log (non-transparent)", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "env FOO=bar pnpm test",
            states: { "pnpm test": "allow" },
        });
        expect(verdict.kind).toBe("defer");
        // env is non-transparent: never unwrapped, so the inner command is not
        // re-evaluated through the deterministic policy.
        expect(check).toEqual([]);
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.env_non_transparent",
                details: { command: "env FOO=bar pnpm test" },
            },
        ]);
    });

    it("does not claim a command that only contains env later", async () => {
        // Starts with printf, not env -> no handler claims it -> silent defer.
        const { verdict, log } = await run({
            recoveredCommand: "printf hi; env | sort",
            states: {},
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]);
    });
});

describe("authorizeInnerCommand — xargs wrapper", () => {
    it("defers on a leading xargs with a debug log (non-transparent args)", async () => {
        const { verdict, log, check } = await run({
            recoveredCommand: "xargs rm",
            states: { rm: "allow" },
        });
        expect(verdict.kind).toBe("defer");
        // xargs arguments come from stdin, so the inner command is never
        // re-evaluated through the deterministic policy.
        expect(check).toEqual([]);
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.xargs_non_transparent",
                details: { command: "xargs rm" },
            },
        ]);
    });

    it("does not claim a command where xargs appears mid-pipeline", async () => {
        // Starts with find, not xargs -> no handler claims it -> silent defer.
        const { verdict, log } = await run({
            recoveredCommand: "find . -name '*.tmp' | xargs rm",
            states: {},
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([]);
    });
});

describe("authorizeInnerCommand — scaffolded commands", () => {
    it("unwraps a timeout buried in a cd/echo/|/tail scaffold", async () => {
        const full =
            "cd /repo && echo go && timeout 240 pnpm install --frozen-lockfile 2>&1 | tail -30; echo EXIT";
        const deWrapped =
            "cd /repo && echo go && pnpm install --frozen-lockfile 2>&1 | tail -30; echo EXIT";
        const { verdict, log, check } = await run({
            recoveredCommand: full,
            unitCommand: "timeout 240 pnpm install --frozen-lockfile",
            states: { [deWrapped]: "allow" },
        });
        expect(verdict.kind).toBe("allow");
        // re-evaluated the full de-wrapped compound, not just the unit's inner
        expect(check).toEqual([
            { surface: "bash", value: deWrapped, agentName: undefined },
        ]);
        expect(log).toEqual([
            {
                level: "review",
                event: "inner_cmd.allow",
                details: {
                    command: full,
                    innerCommand: "pnpm install --frozen-lockfile",
                },
            },
        ]);
    });

    it("defers when the de-wrapped compound is not fully allowing (sibling)", async () => {
        const full = "cd /repo && timeout 30s pnpm test && git push origin";
        const deWrapped = "cd /repo && pnpm test && git push origin";
        const { verdict, check } = await run({
            recoveredCommand: full,
            unitCommand: "timeout 30s pnpm test",
            states: {},
        });
        expect(verdict.kind).toBe("defer");
        // the de-wrapped compound still contains the git push sibling
        expect(check).toEqual([
            { surface: "bash", value: deWrapped, agentName: undefined },
        ]);
    });

    it("defers fail-closed when the unit is not a unique substring", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout   30s pnpm test",
            unitCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toEqual([
            {
                level: "debug",
                event: "inner_cmd.wrapper_not_located",
                details: { command: "timeout   30s pnpm test" },
            },
        ]);
    });
});

describe("authorizeInnerCommand — exceptions defer with a debug log", () => {
    it("defers when reading the session id throws (logs only safe data)", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            getSessionIdThrows: true,
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toHaveLength(1);
        expect(log[0]?.event).toBe("inner_cmd.exception");
        // Exception before recognition: no command/innerCommand available.
        expect(log[0]?.details).toEqual({ error: "session id boom" });
    });

    it("defers when reading the session throws (logs only safe data)", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            getEntriesThrows: true,
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toHaveLength(1);
        expect(log[0]?.level).toBe("debug");
        expect(log[0]?.event).toBe("inner_cmd.exception");
        // Exception before recognition: only the error is available.
        expect(log[0]?.details).toEqual({ error: "session boom" });
    });

    it("retains command and innerCommand when the query throws after recognition", async () => {
        const { verdict, log } = await run({
            recoveredCommand: "timeout 30s pnpm test",
            states: { "pnpm test": "allow" },
            queryThrowsOn: "pnpm test",
        });
        expect(verdict.kind).toBe("defer");
        expect(log).toHaveLength(1);
        expect(log[0]?.event).toBe("inner_cmd.exception");
        // Exception after recognition: command + innerCommand retained.
        expect(log[0]?.details).toEqual({
            error: "policy boom",
            command: "timeout 30s pnpm test",
            innerCommand: "pnpm test",
        });
    });
});
