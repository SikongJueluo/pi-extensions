import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
    createModelAvailability,
    requestStructuredVerdict,
    type ModelAvailability,
} from "../src/model";

const metadata = {
    provider: "test-provider",
    model: "test-model",
    api: "openai-codex-responses",
};

function response(
    content: AssistantMessage["content"],
    output = 12,
    stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: metadata.api,
        provider: metadata.provider,
        model: metadata.model,
        stopReason,
        usage: {
            input: 10,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10 + output,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        timestamp: Date.now(),
    };
}

function ready(
    complete: (
        context: Context,
        signal: AbortSignal,
    ) => Promise<AssistantMessage>,
): ModelAvailability {
    return { kind: "ready", metadata, complete };
}

/** A minimal valid report_verdict tool-call content block. */
function verdictContent(): AssistantMessage["content"] {
    return [
        {
            type: "toolCall",
            id: "call-1",
            name: "report_verdict",
            arguments: { verdict: "allow", reason: "bounded" },
        },
    ];
}

const evidence = {
    fullCommand: "pnpm test && git push",
    triggeringUnit: "git push",
};

describe("requestStructuredVerdict", () => {
    it("makes one call and parses exactly one report_verdict tool call", async () => {
        const complete = vi.fn(
            async (_context: Context, _signal: AbortSignal) =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: {
                            verdict: "defer",
                            reason: "User intent is unavailable.",
                        },
                    },
                ]),
        );

        const result = await requestStructuredVerdict(
            ready(complete),
            evidence,
            new AbortController().signal,
        );

        expect(complete).toHaveBeenCalledTimes(1);
        expect(complete.mock.calls[0]?.[0].tools).toHaveLength(1);
        expect(result).toEqual({
            kind: "judgment",
            verdict: "defer",
            reason: "User intent is unavailable.",
            metadata,
            inputTokens: 10,
            outputTokens: 12,
            modelLatencyMs: expect.any(Number),
        });
    });

    it("never parses prose or duplicate tool calls", async () => {
        const prose = await requestStructuredVerdict(
            ready(async () =>
                response([{ type: "text", text: '{"verdict":"allow"}' }]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(prose).toMatchObject({
            kind: "infrastructure_failure",
            code: "missing_tool_call",
        });

        const call = {
            type: "toolCall" as const,
            id: "call-1",
            name: "report_verdict",
            arguments: { verdict: "allow", reason: "bounded" },
        };
        const duplicate = await requestStructuredVerdict(
            ready(async () => response([call, { ...call, id: "call-2" }])),
            evidence,
            new AbortController().signal,
        );
        expect(duplicate).toMatchObject({
            kind: "infrastructure_failure",
            code: "missing_tool_call",
        });
    });

    it("accepts reasoning-heavy responses within the raised budget", async () => {
        // Observed live on zai glm-5.2: 669 reasoning + 70 output tokens still
        // delivered exactly one valid report_verdict call.
        const complete = vi.fn(
            async (_context: Context, _signal: AbortSignal) =>
                response(
                    [
                        {
                            type: "toolCall",
                            id: "call-1",
                            name: "report_verdict",
                            arguments: {
                                verdict: "allow",
                                reason: "Bounded command with evident intent.",
                            },
                        },
                    ],
                    739,
                ),
        );

        const result = await requestStructuredVerdict(
            ready(complete),
            evidence,
            new AbortController().signal,
        );

        expect(result).toMatchObject({
            kind: "judgment",
            verdict: "allow",
            outputTokens: 739,
        });
    });

    it("rejects invalid arguments, verdicts, reasons, and output usage", async () => {
        const extraArguments = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: {
                            verdict: "allow",
                            reason: "bounded",
                            extra: true,
                        },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(extraArguments).toMatchObject({ code: "invalid_arguments" });

        const invalidVerdict = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: { verdict: "approve", reason: "no" },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(invalidVerdict).toMatchObject({ code: "invalid_verdict" });

        const invalidReason = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: { verdict: "defer", reason: " ".repeat(241) },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(invalidReason).toMatchObject({ code: "invalid_reason" });

        const excessiveUsage = await requestStructuredVerdict(
            ready(async () =>
                response(
                    [
                        {
                            type: "toolCall",
                            id: "call-1",
                            name: "report_verdict",
                            arguments: { verdict: "allow", reason: "bounded" },
                        },
                    ],
                    4_097,
                ),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(excessiveUsage).toMatchObject({
            code: "model_error",
            outputTokens: 4_097,
        });
    });

    it("rejects zero and non-finite output usage", async () => {
        const zeroUsage = await requestStructuredVerdict(
            ready(async () =>
                response(verdictContent(), 0),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(zeroUsage).toMatchObject({ code: "model_error" });

        const nonFiniteUsage = await requestStructuredVerdict(
            ready(async () =>
                response(verdictContent(), Number.NaN),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(nonFiniteUsage).toMatchObject({ code: "model_error" });
    });

    it("rejects responses without exactly one report_verdict tool call", async () => {
        const noCall = await requestStructuredVerdict(
            ready(async () =>
                response([{ type: "text", text: "I would allow it." } as never]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(noCall).toMatchObject({ code: "missing_tool_call" });

        const wrongName = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "other_tool",
                        arguments: { verdict: "allow", reason: "x" },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(wrongName).toMatchObject({ code: "missing_tool_call" });
    });

    it("rejects null and array tool-call arguments", async () => {
        const nullArgs = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: null as unknown as Record<string, unknown>,
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(nullArgs).toMatchObject({ code: "invalid_arguments" });

        const arrayArgs = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: ["allow", "x"] as unknown as Record<string, unknown>,
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(arrayArgs).toMatchObject({ code: "invalid_arguments" });

        const missingKey = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: { verdict: "allow" },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(missingKey).toMatchObject({ code: "invalid_arguments" });
    });

    it("rejects non-string and blank-trimmed reasons", async () => {
        const nonStringReason = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: { verdict: "defer", reason: 42 as unknown as string },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(nonStringReason).toMatchObject({ code: "invalid_reason" });

        const blankReason = await requestStructuredVerdict(
            ready(async () =>
                response([
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "report_verdict",
                        arguments: { verdict: "defer", reason: "   " },
                    },
                ]),
            ),
            evidence,
            new AbortController().signal,
        );
        expect(blankReason).toMatchObject({ code: "invalid_reason" });
    });

    it("maps the bounded deadline to timeout", async () => {
        const waiting = ready(
            async (_context, signal) =>
                new Promise<AssistantMessage>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        );

        const result = await requestStructuredVerdict(
            waiting,
            evidence,
            new AbortController().signal,
            5,
        );
        expect(result).toMatchObject({
            kind: "infrastructure_failure",
            code: "timeout",
        });
    });

    it("normalizes no-model, unsupported API, and shutdown abort", async () => {
        await expect(
            requestStructuredVerdict(
                { kind: "no_model" },
                evidence,
                new AbortController().signal,
            ),
        ).resolves.toEqual({
            kind: "infrastructure_failure",
            code: "no_model",
            metadata: undefined,
            modelCalled: false,
            modelLatencyMs: null,
        });

        await expect(
            requestStructuredVerdict(
                { kind: "unsupported_api", metadata },
                evidence,
                new AbortController().signal,
            ),
        ).resolves.toEqual({
            kind: "infrastructure_failure",
            code: "unsupported_api",
            metadata,
            modelCalled: false,
            modelLatencyMs: null,
        });

        const shutdown = new AbortController();
        shutdown.abort();
        const complete = vi.fn(async () => response([]));
        const aborted = await requestStructuredVerdict(
            ready(complete),
            evidence,
            shutdown.signal,
        );
        expect(aborted).toMatchObject({
            code: "aborted",
            modelCalled: false,
        });
        expect(complete).not.toHaveBeenCalled();
    });

    it("classifies a provider abort arriving after the deadline as timeout", async () => {
        const complete = vi.fn(
            (_context: Context, signal: AbortSignal) =>
                new Promise<AssistantMessage>((resolve, reject) => {
                    signal.addEventListener("abort", () =>
                        // Provider surfaces the client abort as an `aborted`
                        // stopReason after our 1ms deadline already fired.
                        resolve(response([], 12, "aborted")),
                    );
                }),
        );
        const timedOut = await requestStructuredVerdict(
            ready(complete as never),
            evidence,
            new AbortController().signal,
            1,
        );
        expect(timedOut).toMatchObject({ code: "timeout" });
    });
});

describe("createModelAvailability — per-API forced tool choice and output cap", () => {
    it("returns no_model for an undefined model", () => {
        expect(createModelAvailability(undefined, registryStub())).toEqual({
            kind: "no_model",
        });
    });

    it("returns unsupported_api for an unknown api", () => {
        const availability = createModelAvailability(
            modelWithApi("mystery-api"),
            registryStub(),
        );
        expect(availability).toMatchObject({
            kind: "unsupported_api",
            metadata: { api: "mystery-api" },
        });
    });

    it.each([
        // [api, expected toolChoice, enforces output cap]
        ["anthropic-messages", { type: "tool", name: "report_verdict" }, true],
        ["bedrock-converse-stream", { type: "tool", name: "report_verdict" }, true],
        ["google-generative-ai", "any", true],
        ["google-vertex", "any", true],
        ["openai-completions", { type: "function", function: { name: "report_verdict" } }, true],
        ["mistral-conversations", { type: "function", function: { name: "report_verdict" } }, true],
        ["pi-messages", { type: "function", function: { name: "report_verdict" } }, true],
        ["openai-responses", { type: "function", name: "report_verdict" }, true],
        ["azure-openai-responses", { type: "function", name: "report_verdict" }, true],
        // Codex supports required but not named choice, and no output cap.
        ["openai-codex-responses", "required", false],
    ])("maps %s to its forced tool choice and cap policy", async (api, toolChoice, cap) => {
        const calls: Array<Record<string, unknown>> = [];
        const registry = registryStub({
            complete: (_model, _context, options) => {
                calls.push(options as Record<string, unknown>);
                return Promise.resolve(response(verdictContent()));
            },
        });
        const availability = createModelAvailability(modelWithApi(api), registry);
        expect(availability).toMatchObject({ kind: "ready", metadata: { api } });

        if (availability.kind === "ready") {
            await availability.complete({} as never, new AbortController().signal);
        }
        expect(calls[0]?.toolChoice).toEqual(toolChoice);
        if (cap) {
            expect(calls[0]?.maxTokens).toBeTypeOf("number");
        } else {
            expect(calls[0]?.maxTokens).toBeUndefined();
        }
    });

    it("forwards retry and cache policy to the registry", async () => {
        let seen: Record<string, unknown> | undefined;
        const registry = registryStub({
            complete: (_m, _c, options) => {
                seen = options as Record<string, unknown>;
                return Promise.resolve(response(verdictContent()));
            },
        });
        const availability = createModelAvailability(
            modelWithApi("anthropic-messages"),
            registry,
        );
        if (availability.kind === "ready") {
            await availability.complete({} as never, new AbortController().signal);
        }
        expect(seen).toMatchObject({ maxRetries: 0, cacheRetention: "none" });
    });
});

function modelWithApi(api: string): Model<any> {
    return {
        provider: "test-provider",
        id: "test-model",
        api,
    } as unknown as Model<any>;
}

function registryStub(overrides: Partial<ModelRegistry> = {}): ModelRegistry {
    return {
        complete: () => {
            throw new Error("not called");
        },
        ...overrides,
    } as unknown as ModelRegistry;
}
