import { describe, expect, it } from "vitest";
import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { buildBashJudgmentEvidence } from "../src/evidence/bash";

function details(
    unit: string,
    fullCommand = unit,
): PromptPermissionDetails {
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
            evidence:
                fullCommand === unit
                    ? []
                    : [
                          {
                              label: "full command",
                              text: fullCommand,
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

describe("buildBashJudgmentEvidence", () => {
    it("uses request.value when the full command is equal and deduplicated", () => {
        expect(buildBashJudgmentEvidence(details("pnpm test"))).toEqual({
            fullCommand: "pnpm test",
            triggeringUnit: undefined,
        });
    });

    it("uses the unique full-command evidence for a compound input", () => {
        expect(
            buildBashJudgmentEvidence(
                details(
                    "git push origin main",
                    "pnpm test && git push origin main",
                ),
            ),
        ).toEqual({
            fullCommand: "pnpm test && git push origin main",
            triggeringUnit: "git push origin main",
        });
    });

    it("defers on duplicate full-command evidence", () => {
        const ask = details("git push", "cd /repo && git push");
        const evidence = ask.payload.evidence[0]!;
        ask.payload = {
            ...ask.payload,
            evidence: [evidence, evidence],
        };
        expect(buildBashJudgmentEvidence(ask)).toBeUndefined();
    });

    it("defers forwarded and shell-alias asks", () => {
        const forwarded = details("pnpm test");
        forwarded.forwarding = {
            requesterAgentName: "child",
            requesterSessionId: "s1",
        };
        expect(buildBashJudgmentEvidence(forwarded)).toBeUndefined();

        const alias = details("pnpm test");
        alias.payload = {
            ...alias.payload,
            request: {
                ...alias.payload.request,
                invokedToolName: "exec_command",
            },
        };
        expect(buildBashJudgmentEvidence(alias)).toBeUndefined();
    });

    it("defers malformed forwarding and full-command fields", () => {
        const missingForwarded = details("pnpm test");
        missingForwarded.payload = {
            ...missingForwarded.payload,
            request: {
                ...missingForwarded.payload.request,
                requester: {
                    agentName: null,
                    forwarded: undefined as unknown as boolean,
                    sessionId: null,
                },
            },
        };
        expect(buildBashJudgmentEvidence(missingForwarded)).toBeUndefined();

        const nullText = details("git push", "cd /repo && git push");
        nullText.payload = {
            ...nullText.payload,
            evidence: [
                {
                    label: "full command",
                    text: null as unknown as string,
                    detail: null,
                },
            ],
        };
        expect(buildBashJudgmentEvidence(nullText)).toBeUndefined();
    });

    it("defers when legacy and structured command units disagree", () => {
        const ask = details("pnpm test");
        ask.command = "git push";
        expect(buildBashJudgmentEvidence(ask)).toBeUndefined();
    });
});
