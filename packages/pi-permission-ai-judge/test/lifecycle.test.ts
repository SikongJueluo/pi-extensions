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
// Catalog seam (PIEXTENSIO-24): index.ts reads the advisory catalog once
// per session; tests inject entries through this hoisted holder while
// keeping the real classifyModel (pure lookup).
const { mockCatalog } = vi.hoisted(() => ({
    mockCatalog: {
        entries: [] as Array<Record<string, unknown>>,
        diagnostics: [] as Array<Record<string, unknown>>,
    },
}));
vi.mock("../src/catalog", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/catalog")>();
    return {
        ...actual,
        loadModelCatalog: () => ({
            catalog: { version: 1, entries: mockCatalog.entries },
            diagnostics: mockCatalog.diagnostics,
        }),
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
import type { ModelCatalogEntry } from "../src/catalog";
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
    mockCatalog.entries = [];
    mockCatalog.diagnostics = [];
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

    it("records a provider failure as an infrastructure_failure row and defers", async () => {
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
            async () => {
                throw new Error("provider 500");
            },
        );
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
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    resultKind: "infrastructure_failure",
                    verdict: null,
                    effectiveVerdict: "defer",
                    modelCalled: true,
                    code: "model_error",
                    modelSource: "session",
                    riskOverride: null,
                    inputUsage: null,
                    outputUsage: null,
                }),
            },
        ]);
        // The failure row must not leak the provider error text.
        expect(JSON.stringify(reviews)).not.toContain("provider 500");

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

describe("AI judge Enforce authority seam (PIEXTENSIO-23, ADR 0008)", () => {
    beforeEach(() => {
        createMockAgentDir();
    });

    function writeConfig(config: Record<string, unknown>): void {
        writeFileSync(
            join(mockAgentDir.dir, "pi-permission-ai-judge.config.json"),
            JSON.stringify(config),
        );
    }

    interface RunAskOptions {
        /** Config file contents (written before session start). */
        config: Record<string, unknown>;
        /** Command unit for the ask; full command becomes `pnpm test && <unit>`. */
        command?: string;
        /** modelRegistry.find result for a configured judge model (when set). */
        findResult?: Model<any> | undefined;
        /** Whether the found model has configured auth. */
        authConfigured?: boolean;
        /** Overridable model verdict. */
        response?: AssistantMessage;
    }

    async function runAsk(
        options: RunAskOptions,
    ): Promise<{
        verdict: { kind: string };
        reviews: Array<{ event: string; details?: Record<string, unknown> }>;
        notify: ReturnType<typeof vi.fn>;
        complete: ReturnType<typeof vi.fn>;
        find: ReturnType<typeof vi.fn>;
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

        const complete = vi.fn(async () => options.response ?? modelResponse());
        const find = vi.fn(() => options.findResult);
        const hasConfiguredAuth = vi.fn(() => options.authConfigured !== false);
        const notify = vi.fn();
        const sessionManager = fakeSessionManager();
        const ctx = {
            hasUI: true,
            sessionManager,
            model: {
                id: "session-model",
                provider: "session-provider",
                api: "openai-codex-responses",
            } as Model<any>,
            modelRegistry: { complete, find, hasConfiguredAuth },
            ui: { notify },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        writeConfig(options.config);
        harness.start(ctx);
        harness.ready();
        expect(authorize).toBeDefined();

        const unit = options.command ?? "git push origin main";
        const askDetails = ask();
        askDetails.command = unit;
        const request = askDetails.payload.request as { value: string };
        request.value = unit;
        const evidenceEntry = (
            askDetails.payload as { evidence: ReadonlyArray<{ label: string; text: string }> }
        ).evidence[0];
        if (evidenceEntry !== undefined) {
            evidenceEntry.text = `pnpm test && ${unit}`;
        }

        const reviews: Array<{ event: string; details?: Record<string, unknown> }> = [];
        const verdict = await authorize!(
            askDetails,
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
        return { verdict, reviews, notify, complete, find };
    }

    it("grants authority in v2 enforce mode with no promotion records", async () => {
        const { verdict, reviews } = await runAsk({
            config: { version: 2, mode: "enforce" },
        });
        expect(verdict).toEqual({ kind: "allow" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    mode: "enforce",
                    verdict: "allow",
                    effectiveVerdict: "allow",
                    authorityBlockedBy: null,
                    modelSource: "session",
                }),
            },
        ]);
    });

    it("downgrades v1 enforce to shadow with a migration diagnostic notification", async () => {
        const { verdict, reviews, notify, complete } = await runAsk({
            config: { mode: "enforce" },
        });
        expect(verdict).toEqual({ kind: "defer" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    mode: "shadow",
                    verdict: "allow",
                    effectiveVerdict: "defer",
                    authorityBlockedBy: "mode_shadow",
                }),
            },
        ]);
        const notified = notify.mock.calls.map((call) => String(call[0]));
        expect(
            notified.some((message) =>
                /v1 enforce requires explicit migration|version 2/.test(message),
            ),
        ).toBe(true);
        expect(complete).toHaveBeenCalledTimes(1);
    });

    it("defers immediately on a high-risk command in enforce mode without calling the model", async () => {
        const { verdict, reviews, complete } = await runAsk({
            config: { version: 2, mode: "enforce" },
            command: "git clean -xfd",
        });
        expect(verdict).toEqual({ kind: "defer" });
        expect(complete).not.toHaveBeenCalled();
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    resultKind: "preflight_defer",
                    verdict: null,
                    effectiveVerdict: "defer",
                    modelCalled: false,
                    code: "high_risk_override",
                    riskCategory: "data_loss",
                    riskRule: expect.any(String),
                }),
            },
        ]);
    });

    it("still calls the model on a high-risk command in shadow mode, records the override, and defers", async () => {
        const { verdict, reviews, complete } = await runAsk({
            config: { version: 2, mode: "shadow" },
            command: "git clean -xfd",
        });
        expect(complete).toHaveBeenCalledTimes(1);
        expect(verdict).toEqual({ kind: "defer" });
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    resultKind: "judgment",
                    verdict: "allow",
                    effectiveVerdict: "defer",
                    riskOverride: { category: "data_loss", rule: expect.any(String) },
                }),
            },
        ]);
    });

    it("resolves a configured v2 judge model instead of the session model", async () => {
        const { verdict, reviews, complete, find } = await runAsk({
            config: {
                version: 2,
                mode: "enforce",
                model: { provider: "fixed-provider", id: "fixed-model" },
            },
            findResult: {
                id: "fixed-model",
                provider: "fixed-provider",
                api: "openai-codex-responses",
            } as Model<any>,
        });
        expect(find).toHaveBeenCalledWith("fixed-provider", "fixed-model");
        expect(complete).toHaveBeenCalledTimes(1);
        expect((complete.mock.calls[0] as unknown[])[0]).toMatchObject({
            id: "fixed-model",
            provider: "fixed-provider",
        });
        expect(verdict).toEqual({ kind: "allow" });
        expect(reviews[0]?.details).toMatchObject({
            modelSource: "configured",
            provider: "fixed-provider",
            model: "fixed-model",
        });
    });

    it("defers with judge_model_unavailable when a configured model cannot be resolved, without fallback", async () => {
        const { verdict, reviews, complete } = await runAsk({
            config: {
                version: 2,
                mode: "enforce",
                model: { provider: "ghost-provider", id: "ghost-model" },
            },
            findResult: undefined,
        });
        expect(verdict).toEqual({ kind: "defer" });
        expect(complete).not.toHaveBeenCalled();
        expect(reviews).toMatchObject([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    resultKind: "infrastructure_failure",
                    code: "judge_model_unavailable",
                    modelCalled: false,
                    provider: "ghost-provider",
                    model: "ghost-model",
                }),
            },
        ]);
    });

    it("keeps riskOverride on the early judge_model_unavailable row for a high-risk shadow ask", async () => {
        const { reviews } = await runAsk({
            config: {
                version: 2,
                mode: "shadow",
                model: { provider: "ghost-provider", id: "ghost-model" },
            },
            command: "git clean -xfd",
            findResult: undefined,
        });
        expect(reviews[0]?.details).toMatchObject({
            code: "judge_model_unavailable",
            riskOverride: { category: "data_loss", rule: expect.any(String) },
        });
    });

    it("defers with judge_model_unavailable when a configured model lacks auth", async () => {
        const { verdict, reviews, complete } = await runAsk({
            config: {
                version: 2,
                mode: "enforce",
                model: { provider: "p", id: "m" },
            },
            findResult: { id: "m", provider: "p", api: "openai-codex-responses" } as Model<any>,
            authConfigured: false,
        });
        expect(verdict).toEqual({ kind: "defer" });
        expect(complete).not.toHaveBeenCalled();
        expect(reviews[0]?.details).toMatchObject({
            resultKind: "infrastructure_failure",
            code: "judge_model_unavailable",
        });
    });

    it("notifies once per session in v2 enforce mode with the judge model and risk contract", async () => {
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
        const notify = vi.fn();
        const ctx = {
            hasUI: true,
            sessionManager: fakeSessionManager(),
            model: {
                id: "session-model",
                provider: "session-provider",
                api: "openai-codex-responses",
            } as Model<any>,
            modelRegistry: { complete, find: vi.fn(), hasConfiguredAuth: vi.fn(() => true) },
            ui: { notify },
        } as unknown as ExtensionContext;

        const harness = createFakePi();
        extension(harness.pi);
        writeConfig({ version: 2, mode: "enforce" });
        harness.start(ctx);
        harness.ready();

        const enforceNotice = notify.mock.calls.filter((call) =>
            /Enforce/i.test(String(call[0])),
        );
        expect(enforceNotice).toHaveLength(1);
        expect(String(enforceNotice[0]?.[0])).toContain(
            "session-provider/session-model",
        );
        expect(String(enforceNotice[0]?.[0])).toMatch(/risk/i);

        // Two more asks must not repeat the notification.
        for (let i = 0; i < 2; i += 1) {
            await authorize!(ask(), { checkPermission: vi.fn(), getToolPermission: vi.fn() }, {
                review: vi.fn(),
                debug: vi.fn(),
            });
        }
        expect(
            notify.mock.calls.filter((call) => /Enforce/i.test(String(call[0]))),
        ).toHaveLength(1);
        harness.shutdown();
    });

    it("does not show the enforce notification in shadow mode", async () => {
        const { notify } = await runAsk({
            config: { version: 2, mode: "shadow" },
        });
        expect(
            notify.mock.calls.filter((call) => /Enforce/i.test(String(call[0]))),
        ).toHaveLength(0);
    });

    it("appends an untested-model note to the enforce notice for an out-of-catalog model", async () => {
        const { notify } = await runAsk({
            config: { version: 2, mode: "enforce" },
        });
        const enforceNotice = notify.mock.calls
            .map((call) => String(call[0]))
            .find((message) => /Enforce/i.test(message));
        expect(enforceNotice).toBeDefined();
        expect(enforceNotice).toMatch(/untested/i);
        expect(enforceNotice).toMatch(/advisory catalog/i);
    });

    it("adds catalog-status notes for deprecated and revoked enforce models", async () => {
        for (const status of ["deprecated", "revoked"] as const) {
            mockCatalog.entries = [
                {
                    provider: "session-provider",
                    model: "session-model",
                    api: "openai-codex-responses",
                    status,
                    promptVersion: "v",
                    corpusVersion: "v",
                    testedAt: "2026-01-01T00:00:00Z",
                    corpusCases: 21,
                    matched: 21,
                    infrastructureFailures: 0,
                    latencyMs: { p50: 1, p95: 2, max: 3 },
                    reportPath: "reports/x.json",
                } satisfies ModelCatalogEntry,
            ];
            const { notify } = await runAsk({
                config: { version: 2, mode: "enforce" },
            });
            const enforceNotice = notify.mock.calls
                .map((call) => String(call[0]))
                .find((message) => /Enforce/i.test(message));
            expect(enforceNotice).toMatch(new RegExp(`catalog status: ${status}`, "i"));
        }
    });

    it("omits the untested note when the enforce model is catalog-recommended", async () => {
        mockCatalog.entries = [
            {
                provider: "session-provider",
                model: "session-model",
                api: "openai-codex-responses",
                status: "recommended",
                promptVersion: "v",
                corpusVersion: "v",
                testedAt: "2026-01-01T00:00:00Z",
                corpusCases: 21,
                matched: 21,
                infrastructureFailures: 0,
                latencyMs: { p50: 1, p95: 2, max: 3 },
                reportPath: "reports/x.json",
            } satisfies ModelCatalogEntry,
        ];
        const { notify } = await runAsk({
            config: { version: 2, mode: "enforce" },
        });
        const enforceNotice = notify.mock.calls
            .map((call) => String(call[0]))
            .find((message) => /Enforce/i.test(message));
        expect(enforceNotice).toBeDefined();
        expect(enforceNotice).not.toMatch(/untested/i);
        expect(enforceNotice).not.toMatch(/catalog status/i);
    });
});
