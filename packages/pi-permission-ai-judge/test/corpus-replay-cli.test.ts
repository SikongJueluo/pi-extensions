import { describe, expect, it } from "vitest";
import { parseArgs } from "../tools/corpus-replay";

/**
 * PIEXTENSIO-24 CLI contract: qualification (--strict) is defined over the
 * full corpus only — a --case subset is observation-only and must never be
 * able to report qualified. Exit-code mapping itself lives in main()
 * (0 qualified / 1 harness failure / 2 qualification failure) and needs a
 * live model; the parse contract is what keeps the standard honest.
 */

const BASE = ["node", "corpus-replay.ts", "--provider", "p", "--model", "m"];

describe("corpus-replay parseArgs", () => {
    it("accepts --strict with the full corpus", () => {
        const parsed = parseArgs([...BASE, "--strict"]);
        expect("error" in parsed && parsed.error).toBeFalsy();
        expect("strict" in parsed && parsed.strict).toBe(true);
        expect("cases" in parsed && parsed.cases).toBeNull();
    });

    it("rejects --strict together with --case", () => {
        const parsed = parseArgs([...BASE, "--strict", "--case", "a,b"]);
        expect("error" in parsed && /full corpus/.test(parsed.error)).toBe(true);
    });

    it("keeps --case usable without --strict", () => {
        const parsed = parseArgs([...BASE, "--case", "a,b"]);
        expect("error" in parsed && parsed.error).toBeFalsy();
        expect("cases" in parsed && parsed.cases).toEqual(new Set(["a", "b"]));
        expect("strict" in parsed && parsed.strict).toBe(false);
    });

    it("rejects unknown options and missing values", () => {
        expect(
            "error" in parseArgs([...BASE, "--thinking", "high"]),
        ).toBe(true);
        expect("error" in parseArgs([...BASE, "--out"])).toBe(true);
        expect("error" in parseArgs(["node", "corpus-replay.ts"])).toBe(true);
    });
});
