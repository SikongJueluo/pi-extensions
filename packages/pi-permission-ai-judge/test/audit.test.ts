import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../src/audit";

const dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-judge-audit-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function readAudit(agentDir: string): Array<Record<string, unknown>> {
    return readFileSync(
        join(agentDir, "extensions", "pi-permission-ai-judge", "logs", "audit.jsonl"),
        "utf-8",
    )
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createAuditLog — healthy path", () => {
    it("appends one JSONL record per audit call with timestamp and runtime id", () => {
        const agentDir = tmp();
        const log = createAuditLog({
            agentDir,
            runtimeId: "rt-1",
            now: () => "2026-08-18T00:00:00.000Z",
        });
        expect(log.healthy()).toBe(true);

        log.audit("ai_bash_judge.enrolled", { requestId: "perm-a", origin: "local" });
        log.audit("ai_bash_judge.result", { requestId: "perm-a", resultKind: "judgment" });

        const rows = readAudit(agentDir);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
            timestamp: "2026-08-18T00:00:00.000Z",
            judgeRuntimeId: "rt-1",
            event: "ai_bash_judge.enrolled",
            requestId: "perm-a",
            origin: "local",
        });
        expect(rows[1]).toEqual({
            timestamp: "2026-08-18T00:00:00.000Z",
            judgeRuntimeId: "rt-1",
            event: "ai_bash_judge.result",
            requestId: "perm-a",
            resultKind: "judgment",
        });
    });

    it("strips privacy-forbidden keys from audit records", () => {
        const agentDir = tmp();
        const log = createAuditLog({ agentDir, runtimeId: "rt-1" });
        log.audit("ai_bash_judge.result", {
            requestId: "perm-a",
            apiToken: "leak",
            secretPath: "/x",
            verdict: "allow",
        });
        const rows = readAudit(agentDir);
        expect(rows[0]).toEqual({
            timestamp: rows[0].timestamp,
            judgeRuntimeId: "rt-1",
            event: "ai_bash_judge.result",
            requestId: "perm-a",
            verdict: "allow",
        });
        expect(rows[0].apiToken).toBeUndefined();
        expect(rows[0].secretPath).toBeUndefined();
    });

    it("creates nested log directories on first use", () => {
        const agentDir = join(tmp(), "deep", "agent");
        const log = createAuditLog({ agentDir, runtimeId: "rt-1" });
        log.audit("e", {});
        expect(readAudit(agentDir)).toHaveLength(1);
    });
});

describe("createAuditLog — fail-closed health", () => {
    it("marks unhealthy permanently when the write fails once", () => {
        const agentDir = tmp();
        const log = createAuditLog({ agentDir, runtimeId: "rt-1" });
        // Corrupt the logs dir into a file: open("a") on a path whose parent
        // is a regular file throws ENSUREDIR/ENOTDIR.
        const logsDir = join(
            agentDir,
            "extensions",
            "pi-permission-ai-judge",
            "logs",
        );
        rmSync(logsDir, { recursive: true, force: true });
        writeFileSync(logsDir, "not a directory");

        log.audit("e1", {});
        expect(log.healthy()).toBe(false);

        // Sticky: health never recovers within this runtime (ADR 0006).
        log.audit("e2", {});
        expect(log.healthy()).toBe(false);
    });

    it("is unhealthy from creation when the directory cannot be made", () => {
        const agentDir = tmp();
        const poisoned = join(agentDir, "extensions");
        writeFileSync(poisoned, "file blocks mkdir");
        const log = createAuditLog({ agentDir, runtimeId: "rt-1" });
        expect(log.healthy()).toBe(false);
        log.audit("e", {});
        expect(log.healthy()).toBe(false);
    });
});
