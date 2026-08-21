import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CLI-level tests for arg parsing (`parseArgs`), the `--after`/`--before`
 * time window (`withinWindow`), and report rendering (`printReport`).
 * Invalid-arg cases assert the exit contract (stderr + exit 1) that the
 * analyze-shadow CLI documents.
 */

const dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-judge-cli-args-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly status: number;
}

function runExpect(args: readonly string[]): RunResult {
    const cli = join(import.meta.dirname, "..", "..", "src", "analyzer", "cli.ts");
    const r = spawnSync("npx", ["tsx", cli, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        status: r.status ?? -1,
    };
}

function reviewLog(dir: string, lines: readonly object[]): string {
    const path = join(dir, "review.jsonl");
    writeFileSync(
        path,
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return path;
}

describe("analyze-shadow CLI — argument parsing (parseArgs)", () => {
    it("prints usage and exits 0 for --help and -h", () => {
        for (const flag of ["--help", "-h"]) {
            const r = runExpect([flag]);
            expect(r.status).toBe(0);
            expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
        }
    });

    it("rejects missing input path with exit 1", () => {
        const r = runExpect([]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("missing input path");
    });

    it("rejects multiple input paths with exit 1", () => {
        const dir = tmp();
        const a = reviewLog(dir, []);
        const b = reviewLog(dir, []).replace("review", "review2");
        const r = runExpect([a, b]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("multiple input paths");
    });

    it("rejects unknown options with exit 1", () => {
        const dir = tmp();
        const path = reviewLog(dir, []);
        const r = runExpect([path, "--bogus"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("unknown option: --bogus");
    });

    it("rejects --after/--before/--audit without a value", () => {
        const dir = tmp();
        const path = reviewLog(dir, []);
        for (const flag of ["--after", "--before", "--audit"]) {
            const r = runExpect([path, flag]);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain(`${flag} requires a value`);
        }
    });

    it("rejects invalid --after/--before timestamps", () => {
        const dir = tmp();
        const path = reviewLog(dir, []);
        for (const flag of ["--after", "--before"]) {
            const r = runExpect([path, flag, "not-a-timestamp"]);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain(`invalid ${flag} timestamp`);
        }
    });
});

describe("analyze-shadow CLI — time window (withinWindow)", () => {
    const events = (ts: string) => [
        {
            timestamp: ts,
            event: "authorizer_chain_resolved",
            requestId: "req-1",
            links: ["ai-bash-judge"],
        },
        {
            timestamp: ts,
            event: "ai_bash_judge.result",
            requestId: "req-1",
            resultKind: "judgment",
            verdict: "allow",
        },
        {
            timestamp: ts,
            event: "permission_request.approved",
            requestId: "req-1",
            resolution: "approved",
        },
    ];

    it("keeps events inside --after..--before and drops events outside", () => {
        const dir = tmp();
        const path = reviewLog(dir, [
            ...events("2026-08-18T00:00:05Z"), // inside
            ...events("2026-08-18T00:00:01Z").map((e, i) => ({ ...e, requestId: `req-old-${i}` })), // before
            ...events("2026-08-18T23:00:00Z").map((e, i) => ({ ...e, requestId: `req-new-${i}` })), // after
        ]);
        const r = runExpect([
            path,
            "--after", "2026-08-18T00:00:02Z",
            "--before", "2026-08-18T12:00:00Z",
        ]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("enrollments (N): 1");
        expect(r.stdout).toContain("joined rows: 1");
    });

    it("keeps events with a missing timestamp regardless of the window", () => {
        const dir = tmp();
        // First event has no timestamp: survives any window.
        const path = reviewLog(dir, [
            {
                event: "authorizer_chain_resolved",
                requestId: "req-1",
                links: ["ai-bash-judge"],
            },
            ...events("2026-08-18T00:00:05Z").slice(1),
        ]);
        const r = runExpect([
            path,
            "--after", "2026-08-18T00:00:02Z",
        ]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("enrollments (N): 1");
    });
});

describe("analyze-shadow CLI — report rendering (printReport)", () => {
    function joinedLog(dir: string): string {
        return reviewLog(dir, [
            {
                timestamp: "2026-08-18T00:00:01Z",
                event: "authorizer_chain_resolved",
                requestId: "req-1",
                links: ["ai-bash-judge"],
            },
            {
                timestamp: "2026-08-18T00:00:02Z",
                event: "ai_bash_judge.result",
                requestId: "req-1",
                resultKind: "judgment",
                verdict: "allow",
                judgeLatencyMs: 5,
                modelLatencyMs: 3,
            },
            {
                timestamp: "2026-08-18T00:00:03Z",
                event: "permission_request.approved",
                requestId: "req-1",
                resolution: "approved",
            },
            {
                timestamp: "2026-08-18T00:00:04Z",
                event: "authorizer_chain_resolved",
                requestId: "req-2",
                links: ["ai-bash-judge"],
            },
            {
                timestamp: "2026-08-18T00:00:05Z",
                event: "ai_bash_judge.result",
                requestId: "req-2",
                resultKind: "judgment",
                verdict: "deny",
                code: null,
                judgeLatencyMs: 7,
                modelLatencyMs: 4,
            },
            {
                timestamp: "2026-08-18T00:00:06Z",
                event: "permission_request.approved",
                requestId: "req-2",
                resolution: "approved",
            },
        ]);
    }

    it("renders the comparison matrix and counters for mixed judgment rows", () => {
        const dir = tmp();
        const r = runExpect([joinedLog(dir)]);
        expect(r.status).toBe(0);
        // Header + source echo.
        expect(r.stdout).toContain("AI Bash Judge — Shadow diagnostic report");
        expect(r.stdout).toContain("grade: DIAGNOSTIC");
        expect(r.stdout).toContain("source:");
        // Denominator + join counts.
        expect(r.stdout).toContain("enrollments (N): 2");
        expect(r.stdout).toContain("joined rows: 2");
        expect(r.stdout).toContain("joined judgments: 2");
        // Matrix rows for both verdicts (allow|allow, deny|allow).
        expect(r.stdout).toContain("allow|allow: 1");
        expect(r.stdout).toContain("deny|allow: 1");
        // Conservative deny counter incremented by deny|allow.
        expect(r.stdout).toContain("conservative: deny 1, defer 0");
        // Latency lines rendered with p50/p95/max/missing.
        expect(r.stdout).toMatch(/judge latency: p50=\d+ms p95=\d+ms/);
        expect(r.stdout).toMatch(/model latency: p50=\d+ms p95=\d+ms/);
        // No --audit: the audit source line must be absent.
        expect(r.stdout).not.toContain("(enrollment source, ADR 0006)");
    });

    it("renders an empty matrix placeholder and no quarantine section when clean", () => {
        const dir = tmp();
        const r = runExpect([joinedLog(dir)]);
        expect(r.status).toBe(0);
        expect(r.stdout).not.toContain("quarantined rows:");
        // Build an empty log: no events at all — matrix stays empty.
        const empty = reviewLog(dir, []);
        const r2 = runExpect([empty]);
        expect(r2.status).toBe(0);
        expect(r2.stdout).toContain("comparison matrix [verdict|human]:");
        expect(r2.stdout).toContain("(empty)");
        expect(r2.stdout).toContain("N/A");
    });

    it("renders the quarantine section with category counts", () => {
        const dir = tmp();
        // Two results for one request → duplicate_result quarantine.
        const path = reviewLog(dir, [
            {
                timestamp: "2026-08-18T00:00:01Z",
                event: "authorizer_chain_resolved",
                requestId: "req-1",
                links: ["ai-bash-judge"],
            },
            {
                timestamp: "2026-08-18T00:00:02Z",
                event: "ai_bash_judge.result",
                requestId: "req-1",
                resultKind: "judgment",
                verdict: "allow",
            },
            {
                timestamp: "2026-08-18T00:00:03Z",
                event: "ai_bash_judge.result",
                requestId: "req-1",
                resultKind: "judgment",
                verdict: "deny",
            },
            {
                timestamp: "2026-08-18T00:00:04Z",
                event: "permission_request.approved",
                requestId: "req-1",
                resolution: "approved",
            },
        ]);
        const r = runExpect([path]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("quarantined rows:");
        expect(r.stdout).toContain("duplicate_result: 1");
    });
});
