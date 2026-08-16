import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
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
): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: metadata.api,
        provider: metadata.provider,
        model: metadata.model,
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
        stopReason: "toolUse",
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
            outputTokens: 12,
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
});
