import { afterEach, describe, expect, it, vi } from "vitest";
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

let publishedService: PermissionsService | undefined;
afterEach(() => {
    if (publishedService !== undefined) {
        unpublishPermissionsService(publishedService);
        publishedService = undefined;
    }
});

describe("AI judge lifecycle", () => {
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
        const sessionManager = {
            getSessionId: () => "session-root",
        };
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
        expect(reviews).toEqual([
            {
                event: "ai_bash_judge.result",
                details: expect.objectContaining({
                    requestId: "req-1",
                    mode: "shadow",
                    resultKind: "judgment",
                    verdict: "allow",
                    effectiveVerdict: "defer",
                    modelCalled: true,
                }),
            },
        ]);
        expect(JSON.stringify(reviews)).not.toContain("git push");
        expect(JSON.stringify(reviews)).not.toContain("appears bounded");

        harness.shutdown();
        expect(dispose).toHaveBeenCalledTimes(1);
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
