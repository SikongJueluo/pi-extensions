import { describe, expect, it } from "vitest";
import {
    classifyWrapper,
    isRecognizedWrapper,
    parseTimeWrapper,
    parseTimeoutWrapper,
} from "../src/recognizer";

describe("parseTimeoutWrapper", () => {
    it("matches the simple-timeout form", () => {
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

    it("accepts GNU durations: bare integer (seconds) and decimals", () => {
        expect(parseTimeoutWrapper("timeout 240 pnpm test")).toEqual({
            duration: "240",
            innerCommand: "pnpm test",
        });
        expect(parseTimeoutWrapper("timeout 1.5h deploy")).toEqual({
            duration: "1.5h",
            innerCommand: "deploy",
        });
        expect(parseTimeoutWrapper("timeout 2.5s build")).toEqual({
            duration: "2.5s",
            innerCommand: "build",
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

    it("rejects zero, leading-zero, ms, and multi-letter durations", () => {
        expect(parseTimeoutWrapper("timeout 0 pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout 0s pnpm test")).toBeUndefined();
        expect(parseTimeoutWrapper("timeout 0.5s pnpm test")).toBeUndefined();
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

describe("parseTimeWrapper", () => {
    it("matches the bare reserved-word form", () => {
        expect(parseTimeWrapper("time pnpm test")).toEqual({
            innerCommand: "pnpm test",
        });
        expect(parseTimeWrapper("time\techo hi")).toEqual({
            innerCommand: "echo hi",
        });
        expect(parseTimeWrapper("time   build")).toEqual({
            innerCommand: "build",
        });
    });

    it("preserves compound inner programs as the inner command", () => {
        expect(parseTimeWrapper("time pnpm test && git push")).toEqual({
            innerCommand: "pnpm test && git push",
        });
        expect(parseTimeWrapper("time bash -c something")).toEqual({
            innerCommand: "bash -c something",
        });
    });

    it("rejects modifier args regardless of separator width", () => {
        // A dash right after the separator means flags: not transparent.
        expect(parseTimeWrapper("time -p ls")).toBeUndefined();
        // Backtracking must not smuggle a leading space into the inner.
        expect(parseTimeWrapper("time  -p ls")).toBeUndefined();
        expect(parseTimeWrapper("time\t-- ls")).toBeUndefined();
        expect(parseTimeWrapper("time -o out.txt ls")).toBeUndefined();
    });

    it("rejects a bare time and non-time commands", () => {
        expect(parseTimeWrapper("time")).toBeUndefined();
        expect(parseTimeWrapper("timeout 10s ls")).toBeUndefined();
        expect(parseTimeWrapper("my-time ls")).toBeUndefined();
        expect(parseTimeWrapper("/usr/bin/time ls")).toBeUndefined();
    });
});

describe("isRecognizedWrapper", () => {
    it("is true for the strict forms and false otherwise", () => {
        expect(isRecognizedWrapper("timeout 10s pnpm test")).toBe(true);
        expect(isRecognizedWrapper("timeout 10s timeout 5s pnpm test")).toBe(
            true,
        );
        expect(isRecognizedWrapper("time pnpm test")).toBe(true);
        expect(isRecognizedWrapper("time timeout 5s pnpm test")).toBe(true);
        expect(isRecognizedWrapper("timeout 10s time pnpm test")).toBe(true);
        expect(isRecognizedWrapper("pnpm test")).toBe(false);
        expect(isRecognizedWrapper("timeout -k 5s 30s pnpm test")).toBe(false);
        expect(isRecognizedWrapper("time -p pnpm test")).toBe(false);
    });
});

describe("classifyWrapper", () => {
    it("classifies recognized wrappers with their name", () => {
        expect(classifyWrapper("timeout 30s pnpm test")).toEqual({
            kind: "recognized",
            wrapper: "timeout",
            match: { duration: "30s", innerCommand: "pnpm test" },
        });
        expect(classifyWrapper("time pnpm test")).toEqual({
            kind: "recognized",
            wrapper: "time",
            match: { innerCommand: "pnpm test" },
        });
    });

    it("classifies unsupported wrapper syntax with its name", () => {
        expect(classifyWrapper("timeout -k 5s 30s pnpm test")).toEqual({
            kind: "unsupported",
            wrapper: "timeout",
        });
        expect(classifyWrapper("timeout 30s")).toEqual({
            kind: "unsupported",
            wrapper: "timeout",
        });
        expect(classifyWrapper("timeout --help")).toEqual({
            kind: "unsupported",
            wrapper: "timeout",
        });
        expect(classifyWrapper("time -p ls")).toEqual({
            kind: "unsupported",
            wrapper: "time",
        });
        expect(classifyWrapper("time")).toEqual({
            kind: "unsupported",
            wrapper: "time",
        });
    });

    it("classifies ordinary commands as other", () => {
        expect(classifyWrapper("pnpm test").kind).toBe("other");
        expect(classifyWrapper("rm -rf /").kind).toBe("other");
        expect(classifyWrapper("git push").kind).toBe("other");
        expect(classifyWrapper("/usr/bin/time ls").kind).toBe("other");
    });
});
