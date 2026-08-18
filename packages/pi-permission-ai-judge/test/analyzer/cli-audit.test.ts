import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CLI-level test for the ADR 0006 dual-log mode: `--audit` switches the
 * enrollment denominator to the Judge-owned audit log's enrolled rows.
 */

const dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-judge-cli-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function run(args: readonly string[]): string {
    const cli = join(import.meta.dirname, "..", "..", "src", "analyzer", "cli.ts");
    return execFileSync("npx", ["tsx", cli, ...args], {
        encoding: "utf-8",
        // The review log path is the first positional arg.
    });
}

describe("analyze-shadow CLI — --audit dual-log mode", () => {
    it("takes enrollment from the audit log and keeps human decisions from the review log", () => {
        const dir = tmp();
        const reviewLog = join(dir, "review.jsonl");
        const auditLog = join(dir, "audit.jsonl");

        // Review log: chain_resolved for req-A (should be IGNORED as
        // enrollment when --audit is given) and req-B has no chain row at
        // all (chain event lost) but IS in the audit log — it must enroll.
        writeFileSync(
            reviewLog,
            [
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:01Z",
                    event: "authorizer_chain_resolved",
                    requestId: "req-A",
                    links: ["ai-bash-judge"],
                }),
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:02Z",
                    event: "ai_bash_judge.result",
                    requestId: "req-A",
                    resultKind: "judgment",
                    verdict: "allow",
                }),
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:03Z",
                    event: "permission_request.approved",
                    requestId: "req-A",
                    resolution: "approved",
                }),
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:04Z",
                    event: "ai_bash_judge.result",
                    requestId: "req-B",
                    resultKind: "judgment",
                    verdict: "defer",
                }),
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:05Z",
                    event: "permission_request.denied",
                    requestId: "req-B",
                    resolution: "denied_with_reason",
                }),
            ].join("\n") + "\n",
        );

        // Audit log: only req-B enrolled (judge received req-B; req-A never
        // reached the judge callback even though the chain resolved).
        writeFileSync(
            auditLog,
            [
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:04Z",
                    judgeRuntimeId: "rt-1",
                    event: "ai_bash_judge.enrolled",
                    requestId: "req-B",
                    origin: "local",
                    surface: "bash",
                    command: "git push origin main",
                }),
            ].join("\n") + "\n",
        );

        const out = run([reviewLog, "--audit", auditLog]);
        expect(out).toContain("audit: " + auditLog);
        // Denominator is the audit enrollment only: req-A does not enroll.
        expect(out).toContain("enrollments (N): 1");
        expect(out).toContain("joined rows: 1");
        // req-B: defer|deny is a conservative row, no false allow.
        expect(out).not.toContain("false allows: 1");
        // req-A's result+decision without enrollment stays out of the join.
        expect(out).toContain("joined judgments: 1");
    });

    it("applies the --after window to audit enrolled rows too", () => {
        const dir = tmp();
        const reviewLog = join(dir, "review.jsonl");
        const auditLog = join(dir, "audit.jsonl");
        writeFileSync(reviewLog, "\n");
        writeFileSync(
            auditLog,
            [
                JSON.stringify({
                    timestamp: "2026-08-17T00:00:00Z",
                    event: "ai_bash_judge.enrolled",
                    requestId: "req-old",
                }),
                JSON.stringify({
                    timestamp: "2026-08-18T00:00:00Z",
                    event: "ai_bash_judge.enrolled",
                    requestId: "req-new",
                }),
            ].join("\n") + "\n",
        );
        const out = run([
            reviewLog,
            "--audit", auditLog,
            "--after", "2026-08-17T12:00:00Z",
        ]);
        expect(out).toContain("enrollments (N): 1");
    });
});
