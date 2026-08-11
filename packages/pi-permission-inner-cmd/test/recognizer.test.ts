import { describe, expect, it } from "vitest";
import {
    classifyWrapper,
    isRecognizedWrapper,
    parseTimeoutWrapper,
} from "../src/recognizer";

describe("parseTimeoutWrapper", () => {
    it("matches the strict simple-timeout form", () => {
        expect(parseTimeoutWrapper("timeout 30s pnpm test")).toEqual({
            duration: "30s",
            innerCommand: "pnpm test",
        });
        expect(parseTimeoutWrapper("timeout 1m echo hi")).toEqual({
            duration: "1m",
            innerCommand: "echo hi",
        });
        expect(parseTimeoutWrapper("timeout 5h deploy")).toEqual({
            duration: "5h",
            innerCommand: "deploy",
        });
        expect(parseTimeoutWrapper("timeout 2d longjob")).toEqual({
            duration: "2d",
            innerCommand: "longjob",
        });
    });

    it("preserves compound inner programs as the inner command", () => {
        expect(parseTimeoutWrapper("timeout 60s pnpm test && git push")).toEqual({
            duration: "60s",
            innerCommand: "pnpm test && git push",
        });
        expect(parseTimeoutWrapper("timeout 30s bash -c something")).toEqual({
            duration: "30s",
            innerCommand: "bash -c something",
        });
    });

    it("accepts tab-separated and multi-space arguments", () => {
        expect(parseTimeoutWrapper("timeout\t30s\tpnpm test")).toEqual({
            duration: "30s",
            innerCommand: "pnpm test",
        });
        expect(parseTimeoutWrapper("timeout   10s   build")).toEqual({
            duration: "10s",
            innerCommand: "build",
        });
    });

    it("rejects leading-zero and multi-letter durations", () => {
        expect(parseTimeoutWrapper("timeout 0s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout 030s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout 30ms pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout 30sec pnpm test")).toBeUndefined();
    });

    it("rejects unsupported timeout syntax", () => {
        expect(parseTimeoutWrapper("timeout -k 5s 30s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout --preserve-status 30s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout -- 30s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout 30s")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout")).toBeUndefined();
    });

    it("does not match commands that merely contain timeout", () => {
        expect(parseTimeoutWrapper("pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout30s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("my-timeout 30s pnpm test")).toBeUndefined();
    });
});

describe("isRecognizedWrapper", () => {
    it("is true for the strict form and false otherwise", () => {
        expect(isRecognizedWrapper("timeout 10s pnpm test")).toBe(true);
        expect(isRecognizedWrapper("timeout 10s timeout 5s pnpm test")).toBe(true);
        expect(isRecognizedWrapper("pnpm test")).toBe(false);
        expect(isRecognizedWrapper("timeout -k 5s 30s pnpm test")).toBe(false);
    });
});

describe("classifyWrapper", () => {
    it("classifies the recognized wrapper", () => {
        expect(classifyWrapper("timeout 30s pnpm test")).toEqual({
            kind: "recognized",
            match: { duration: "30s", innerCommand: "pnpm test" },
        });
    });

    it("classifies unsupported timeout syntax", () => {
        expect(classifyWrapper("timeout -k 5s 30s pnpm test").kind).toBe(
            "unsupportedTimeout",
        );
        expect(classifyWrapper("timeout 30s").kind).toBe("unsupportedTimeout");
        expect(classifyWrapper("timeout --help").kind).toBe("unsupportedTimeout");
    });

    it("classifies ordinary commands as non-timeout", () => {
        expect(classifyWrapper("pnpm test").kind).toBe("nonTimeout");
        expect(classifyWrapper("rm -rf /").kind).toBe("nonTimeout");
        expect(classifyWrapper("git push").kind).toBe("nonTimeout");
    });
});
