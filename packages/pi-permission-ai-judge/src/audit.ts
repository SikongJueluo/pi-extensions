import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    writeSync,
    fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { stripForbiddenKeys } from "./review";

/**
 * Judge-owned audit log (ADR 0006: enforce audit self-sufficiency).
 *
 * The accountability record Enforce needs lives in the Judge package, not
 * in an upstream host contract: a separate JSONL file under the agent dir,
 * append + fsync per record. A failed write marks this runtime
 * **permanently unhealthy** (sticky — a flip-flopping audit trail is worse
 * than a dead one), and the Enforce truth table's `auditHealthy` gate
 * refuses authority while unhealthy.
 *
 * The privacy denylist matches the review sink: event keys matching the
 * forbidden patterns are stripped before the record is serialized.
 */

export interface AuditLog {
    /** Append one metadata-only record; marks the runtime unhealthy on failure. */
    readonly audit: (event: string, details: Record<string, unknown>) => void;
    /** False after any write or setup failure (sticky for the runtime). */
    readonly healthy: () => boolean;
    /** Absolute path of the audit file. */
    readonly path: () => string;
}

export interface AuditLogDeps {
    /** User-global agent dir (`~/.pi/agent`); the audit file lives under it. */
    readonly agentDir: string;
    /** Runtime identity stamped on every record. */
    readonly runtimeId: string;
    /** Injectable clock for tests; defaults to ISO-now. */
    readonly now?: () => string;
}

const AUDIT_DIR_SEGMENTS = ["extensions", "pi-permission-ai-judge", "logs"];
const AUDIT_FILENAME = "audit.jsonl";

export function createAuditLog(deps: AuditLogDeps): AuditLog {
    const now = deps.now ?? (() => new Date().toISOString());
    const dir = join(deps.agentDir, ...AUDIT_DIR_SEGMENTS);
    const file = join(dir, AUDIT_FILENAME);
    let healthy = true;

    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        healthy = false;
    }

    return {
        audit: (event, details) => {
            if (!healthy) {
                // Sticky-fail: keep the API total but write nothing further.
                return;
            }
            const record = JSON.stringify({
                timestamp: now(),
                judgeRuntimeId: deps.runtimeId,
                event,
                ...stripForbiddenKeys(details),
            });
            let fd: number | undefined;
            try {
                fd = openSync(file, "a");
                writeSync(fd, `${record}\n`);
                fsyncSync(fd);
            } catch {
                healthy = false;
            } finally {
                if (fd !== undefined) {
                    try {
                        closeSync(fd);
                    } catch {
                        // Close failure does not un-fail the write.
                    }
                }
            }
        },
        healthy: () => healthy,
        path: () => file,
    };
}
