import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic agent dir: index.ts reads config and writes the audit log via
// getAgentDir(); point both at a temp dir so lifecycle tests neither read
// the operator's real config nor pollute the real audit record (ADR 0006).
const { mockAgentDir, createMockAgentDir, cleanupMockAgentDir } = vi.hoisted(() => {
    const state = { dir: "" };
    return {
        mockAgentDir: state,
        createMockAgentDir: () => {
            state.dir = mkdtempSync(join(tmpdir(), "ai-judge-lifecycle-"));
        },
        cleanupMockAgentDir: () => {
            if (state.dir) {
                rmSync(state.dir, { recursive: true, force: true });
                state.dir = "";
            }
        },
    };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@earendil-works/pi-coding-agent")
        >();
    return {
        ...actual,
        getAgentDir: () => mockAgentDir.dir || "/nonexistent-ai-judge-test",
    };
});
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionShutdownEvent,
    SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type {
    Authorizer,
    PermissionsService,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
    PERMISSIONS_READY_CHANNEL,
    publishPermissionsService,
    unpublishPermissionsService,
} from "@gotgenes/pi-permission-system";
import extension from "../src/index";
import { appendPromotionRecord, type CandidateIdentity } from "../src/promotion";
import { PROMPT_VERSION, TOOL_SCHEMA_VERSION } from "../src/prompt";

function createFakePi(): {
    pi: ExtensionAPI;
    start: (ctx: ExtensionContext) => void;
    shutdown: () => void;
    ready: () => void;
} {
    const starts: Array<
        (event: SessionStartEvent, ctx: ExtensionContext) => unknown
    > = [];
    const shutdowns: Array<(event: SessionShutdownEvent) => unknown> = [];
    const readyHandlers: Array<() => unknown> = [];
    const pi = {
        on(event: string, handler: (...args: never[]) => unknown): void {
            if (event === "session_start") starts.push(handler as never);
            if (event === "session_shutdown") shutdowns.push(handler as never);
        },
        events: {
            on(channel: string, handler: () => unknown): void {
                if (channel === PERMISSIONS_READY_CHANNEL) {
                    readyHandlers.push(handler);
                }
            },
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        start: (ctx) => {
            const event = {
                type: "session_start",
                reason: "startup",
            } as SessionStartEvent;
            for (const handler of starts) handler(event, ctx);
        },
        shutdown: () => {
            const event = { type: "session_shutdown" } as SessionShutdownEvent;
            for (const handler of shutdowns) handler(event);
        },
        ready: () => {
            for (const handler of readyHandlers) handler();
        },
    };
}

function ask(): PromptPermissionDetails {
    const unit = "git push origin main";
    return {
        requestId: "req-1",
        source: "tool_call",
        agentName: null,
        message: "bash ask",
        payload: {
            kind: "bash",
            request: {
                requester: {
                    agentName: null,
                    forwarded: false,
                    sessionId: null,
                },
                surface: "bash",
                toolName: "bash",
                invokedToolName: null,
                value: unit,
                matchedPattern: null,
                commandContext: null,
                executedUnit: null,
            },
            evidence: [
                {
                    label: "full command",
                    text: `pnpm test && ${unit}`,
                    detail: null,
                },
            ],
            annotations: [],
        },
        toolCallId: "call-1",
        toolName: "bash",
        command: unit,
    };
}

function modelResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [
            {
                type: "toolCall",
                id: "verdict-1",
                name: "report_verdict",
                arguments: {
                    verdict: "allow",
                    reason: "The command appears bounded.",
                },
            },
        ],
        api: "openai-codex-responses",
        provider: "test-provider",
        model: "test-model",
        usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
    };
}

function fakeSessionManager(): {
    getSessionId: () => string;
    getEntries: () => unknown[];
    getLeafId: () => string | null;
    getCwd: () => string;
} {
    return {
        getSessionId: () => "session-root",
        getEntries: () => [],
        getLeafId: () => null,
        getCwd: () => "/repo",
    };
}

let publishedService: PermissionsService | undefined;
afterEach(() => {
    if (publishedService !== undefined) {
        unpublishPermissionsService(publishedService);
        publishedService = undefined;
    }
    cleanupMockAgentDir();
});

describe("AI judge lifecycle", () => {
    beforeEach(() => {
        createMockAgentDir();
    });

    it("captures the model per request: a between-request switch changes the next call", async () => {
        let authorize: Authorizer["authorize"] | undefined;
        const service = {
            registerAuthorizer: vi.fn((_name, callback) => {
                authorize = callback;
                return vi.fn();
            }),
            checkPermission: vi.fn(),
            getToolPermission: vi.fn(),
        } as unknown as PermissionsService;
        publishPermissionsService(service);
        publishedService = service;

        // A mutable "current model" the session switches mid-run.
        let currentModel = {
            id: "model-a",
            provider: "test-provider",
            api: "openai-codex-responses",
        } as Model<any>;
        const seen: string[] = [];
        const complete = vi.fn(async (model: Model<any>) => {
            seen.push(model.id);
            return modelResponse();
        });
        const ctx = {
            hasUI: true,
            sessionManager: fakeSessionManager(),
            get model() {
                return currentModel;
            },
            modelRegistry: { complete },
            ui: { notify: vi.fn() },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        harness.start(ctx);
        harness.ready();

        const log = {
            review: vi.fn(),
            debug: vi.fn(),
        };
        await authorize!(ask(), { checkPermission: vi.fn(), getToolPermission: vi.fn() }, log);
        currentModel = {
            id: "model-b",
            provider: "test-provider",
            api: "openai-codex-responses",
        } as Model<any>;
        await authorize!(ask(), { checkPermission: vi.fn(), getToolPermission: vi.fn() }, log);

        expect(seen).toEqual(["model-a", "model-b"]);

        // ADR 0006: the Judge-owned audit log mirrors every result and
        // records enrollment (denominator), in the hermetic agent dir.
        const auditText = readFileSync(
            join(
                mockAgentDir.dir,
                "extensions",
                "pi-permission-ai-judge",
                "logs",
                "audit.jsonl",
            ),
            "utf-8",
        );
        const auditRows = auditText
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(auditRows).toHaveLength(4); // enrolled+result × 2 asks
        expect(auditRows.filter((r) => r.event === "ai_bash_judge.enrolled"))
            .toHaveLength(2);
        expect(auditRows.filter((r) => r.event === "ai_bash_judge.result"))
            .toHaveLength(2);
        expect(
            auditRows.every(
                (r) => r.judgeRuntimeId === auditRows[0].judgeRuntimeId,
            ),
        ).toBe(true);
        harness.shutdown();
    });

    it("feeds conversation user text into the model prompt as quoted evidence", async () => {
        let authorize: Authorizer["authorize"] | undefined;
        const service = {
            registerAuthorizer: vi.fn((_name, callback) => {
                authorize = callback;
                return vi.fn();
            }),
            checkPermission: vi.fn(),
            getToolPermission: vi.fn(),
        } as unknown as PermissionsService;
        publishPermissionsService(service);
        publishedService = service;

        const complete = vi.fn(
            async (
                _model: Model<any>,
                _context: Context,
            ): Promise<AssistantMessage> => modelResponse(),
        );
        const sessionManager = fakeSessionManager();
        (sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
            {
                type: "message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "please push the release tag" }],
                },
            },
        ];
        const ctx = {
            hasUI: true,
            sessionManager,
            model: {
                id: "test-model",
                provider: "test-provider",
                api: "openai-codex-responses",
            } as Model<any>,
            modelRegistry: { complete },
            ui: { notify: vi.fn() },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        harness.start(ctx);
        harness.ready();

        const log = {
            review: vi.fn(),
            debug: vi.fn(),
        };
        await authorize!(ask(), { checkPermission: vi.fn(), getToolPermission: vi.fn() }, log);

        expect(complete).toHaveBeenCalledTimes(1);
        const promptText = JSON.stringify(complete.mock.calls[0]?.[1]);
        expect(promptText).toContain("please push the release tag");
        expect(promptText).toContain("user_intent_evidence");
        // The review row carries quality flags, not conversation content.
        expect(JSON.stringify(log.review.mock.calls)).not.toContain(
            "please push the release tag",
        );
        expect(log.review.mock.calls[0]?.[1]).toMatchObject({
            evidenceQuality: expect.objectContaining({
                explicitUserText: true,
                conversationItems: 1,
                requesterCwd: "/repo",
            }),
        });
        harness.shutdown();
    });

    it("calls the current model once, records metadata, and still defers in Shadow", async () => {
        let authorize: Authorizer["authorize"] | undefined;
        const dispose = vi.fn();
        const service = {
            registerAuthorizer: vi.fn((_name, callback) => {
                authorize = callback;
                return dispose;
            }),
            checkPermission: vi.fn(),
            getToolPermission: vi.fn(),
        } as unknown as PermissionsService;
        publishPermissionsService(service);
        publishedService = service;

        const complete = vi.fn(
            async (
                _model: Model<any>,
                _context: Context,
                _options?: Record<string, unknown>,
            ) => modelResponse(),
        );
        const sessionManager = fakeSessionManager();
        const model = {
            id: "test-model",
            provider: "test-provider",
            api: "openai-codex-responses",
        } as Model<any>;
        const ctx = {
            hasUI: true,
            sessionManager,
            model,
            modelRegistry: { complete },
            ui: { notify: vi.fn() },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        harness.start(ctx);
        harness.ready();
        expect(authorize).toBeDefined();

        const reviews: Array<{
            event: string;
            details?: Record<string, unknown>;
        }> = [];
        const verdict = await authorize!(
            ask(),
            {
                checkPermission: vi.fn(),
                getToolPermission: vi.fn(),
            },
            {
                review: (event, details) => reviews.push({ event, details }),
                debug: vi.fn(),
            },
        );

        expect(verdict).toEqual({ kind: "defer" });
        expect(complete).toHaveBeenCalledTimes(1);
        expect(complete.mock.calls[0]?.[2]).toMatchObject({
            maxRetries: 0,
            toolChoice: "required",
        });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    requestId: "req-1",
                    mode: "shadow",
                    origin: "local",
                    judgeRuntimeId: expect.any(String),
                    promptVersion: "bash-shadow-v4",
                    toolSchemaVersion: "report-verdict-v1",
                    judgeLatencyMs: expect.any(Number),
                    modelLatencyMs: expect.any(Number),
                    inputUsage: 20,
                    outputUsage: 10,
                    resultKind: "judgment",
                    verdict: "allow",
                    effectiveVerdict: "defer",
                    modelCalled: true,
                    evidenceQuality: expect.objectContaining({
                        structuredFullInput: true,
                        explicitUserText: false,
                    }),
                }),
            },
        ]);
        expect(JSON.stringify(reviews)).not.toContain("git push");
        expect(JSON.stringify(reviews)).not.toContain("appears bounded");

        harness.shutdown();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("records a forwarded ask as a preflight defer without calling the model", async () => {
        let authorize: Authorizer["authorize"] | undefined;
        const service = {
            registerAuthorizer: vi.fn((_name, callback) => {
                authorize = callback;
                return vi.fn();
            }),
            checkPermission: vi.fn(),
            getToolPermission: vi.fn(),
        } as unknown as PermissionsService;
        publishPermissionsService(service);
        publishedService = service;

        const complete = vi.fn();
        const ctx = {
            hasUI: true,
            sessionManager: fakeSessionManager(),
            model: {
                id: "test-model",
                provider: "test-provider",
                api: "openai-codex-responses",
            } as Model<any>,
            modelRegistry: { complete },
            ui: { notify: vi.fn() },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        harness.start(ctx);
        harness.ready();

        const reviews: Array<{
            event: string;
            details?: Record<string, unknown>;
        }> = [];
        const forwarded = {
            ...ask(),
            forwarding: { requestId: "fwd-1" } as never,
        } as PromptPermissionDetails;
        const verdict = await authorize!(
            forwarded,
            {
                checkPermission: vi.fn(),
                getToolPermission: vi.fn(),
            },
            {
                review: (event, details) => reviews.push({ event, details }),
                debug: vi.fn(),
            },
        );

        expect(verdict).toEqual({ kind: "defer" });
        expect(complete).not.toHaveBeenCalled();
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    requestId: "req-1",
                    origin: "forwarded",
                    resultKind: "preflight_defer",
                    verdict: null,
                    effectiveVerdict: "defer",
                    modelCalled: false,
                    code: "missing_structured_input",
                    evidenceQuality: expect.objectContaining({
                        structuredFullInput: false,
                        forwardedProvenance: false,
                    }),
                }),
            },
        ]);

        harness.shutdown();
    });

    it("does not register from a headless child", () => {
        const service = {
            registerAuthorizer: vi.fn(),
        } as unknown as PermissionsService;
        publishPermissionsService(service);
        publishedService = service;

        const harness = createFakePi();
        extension(harness.pi);
        harness.start({
            hasUI: false,
            sessionManager: { getSessionId: () => "child" },
            model: undefined,
            modelRegistry: {},
        } as unknown as ExtensionContext);
        harness.ready();

        expect(service.registerAuthorizer).not.toHaveBeenCalled();
    });
});

describe("AI judge Enforce authority seam (PIEXTENSIO-21)", () => {
    beforeEach(() => {
        createMockAgentDir();
        writeFileSync(
            join(mockAgentDir.dir, "pi-permission-ai-judge.config.json"),
            JSON.stringify({ mode: "enforce" }),
        );
    });

    /** Records identity matching the lifecycle fake model + static fields. */
    function lifecycleIdentity(): CandidateIdentity {
        return {
            judge: "@sikongjueluo/pi-permission-ai-judge@0.0.1",
            permissionSystem: "25.4.0",
            provider: "test-provider",
            model: "test-model",
            api: "openai-codex-responses",
            promptVersion: PROMPT_VERSION,
            toolSchemaVersion: TOOL_SCHEMA_VERSION,
            reviewSchemaVersion: "1",
            timeoutCohort: "default",
        };
    }

    async function runAsk(): Promise<{
        verdict: { kind: string };
        reviews: Array<{ event: string; details?: Record<string, unknown> }>;
    }> {
        let authorize: Authorizer["authorize"] | undefined;
        const service = {
            registerAuthorizer: vi.fn((_name, callback) => {
                authorize = callback;
                return vi.fn();
            }),
            checkPermission: vi.fn(),
            getToolPermission: vi.fn(),
        } as unknown as PermissionsService;
        publishPermissionsService(service);
        publishedService = service;

        const complete = vi.fn(async () => modelResponse());
        const ctx = {
            hasUI: true,
            sessionManager: fakeSessionManager(),
            model: {
                id: "test-model",
                provider: "test-provider",
                api: "openai-codex-responses",
            } as Model<any>,
            modelRegistry: { complete },
            ui: { notify: vi.fn() },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        harness.start(ctx);
        harness.ready();
        expect(authorize).toBeDefined();

        const reviews: Array<{ event: string; details?: Record<string, unknown> }> = [];
        const verdict = await authorize!(
            ask(),
            {
                checkPermission: vi.fn(),
                getToolPermission: vi.fn(),
            },
            {
                review: (event, details) => reviews.push({ event, details }),
                debug: vi.fn(),
            },
        );
        harness.shutdown();
        return { verdict, reviews };
    }

    it("defers in enforce mode when no promotion records exist", async () => {
        const { verdict, reviews } = await runAsk();
        expect(verdict).toEqual({ kind: "defer" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    mode: "enforce",
                    verdict: "allow",
                    effectiveVerdict: "defer",
                    authorityBlockedBy: "cohort_not_qualified",
                }),
            },
        ]);
    });

    it("grants authority in enforce mode only with all three exact-identity records", async () => {
        const identity = lifecycleIdentity();
        for (const [kind, basis] of [
            ["cohort_qualified", "cohort piextensio-test"],
            ["owner_approval", "approved for test"],
            ["activation", "activated for test"],
        ] as const) {
            expect(
                appendPromotionRecord({
                    agentDir: mockAgentDir.dir,
                    record: {
                        kind,
                        candidateIdentity: identity,
                        recordedAt: "2026-08-21T10:00:00Z",
                        basis,
                    },
                }),
            ).toBeNull();
        }
        const { verdict, reviews } = await runAsk();
        expect(verdict).toEqual({ kind: "allow" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    mode: "enforce",
                    verdict: "allow",
                    effectiveVerdict: "allow",
                    authorityBlockedBy: null,
                }),
            },
        ]);
    });

    it("defers in enforce mode when records exist for another identity", async () => {
        const identity = { ...lifecycleIdentity(), model: "other-model" };
        for (const kind of [
            "cohort_qualified",
            "owner_approval",
            "activation",
        ] as const) {
            appendPromotionRecord({
                agentDir: mockAgentDir.dir,
                record: {
                    kind,
                    candidateIdentity: identity,
                    recordedAt: "2026-08-21T10:00:00Z",
                    basis: "other identity",
                },
            });
        }
        const { verdict, reviews } = await runAsk();
        expect(verdict).toEqual({ kind: "defer" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    effectiveVerdict: "defer",
                    authorityBlockedBy: "cohort_not_qualified",
                }),
            },
        ]);
    });

    it("never grants authority in shadow mode regardless of records", async () => {
        writeFileSync(
            join(mockAgentDir.dir, "pi-permission-ai-judge.config.json"),
            JSON.stringify({ mode: "shadow" }),
        );
        const identity = lifecycleIdentity();
        for (const kind of [
            "cohort_qualified",
            "owner_approval",
            "activation",
        ] as const) {
            appendPromotionRecord({
                agentDir: mockAgentDir.dir,
                record: {
                    kind,
                    candidateIdentity: identity,
                    recordedAt: "2026-08-21T10:00:00Z",
                    basis: "shadow still defers",
                },
            });
        }
        const { verdict, reviews } = await runAsk();
        expect(verdict).toEqual({ kind: "defer" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    mode: "shadow",
                    effectiveVerdict: "defer",
                    authorityBlockedBy: "mode_shadow",
                }),
            },
        ]);
    });
});
