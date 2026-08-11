import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";
import { authorizeInnerCommand, type SessionProbe } from "./authorizer";

const LINK_NAME = "inner-cmd";

/** Captured UI-root session: the live probe plus its identity provenance. */
interface CapturedRootSession {
    readonly session: SessionProbe;
    readonly sessionId: string;
}

export default function permissionInnerCmd(pi: ExtensionAPI): void {
    let rootSession: CapturedRootSession | undefined;
    let disposeAuthorizer: (() => void) | undefined;

    /**
     * Register the inner-command Authorizer once a proven UI-root session is
     * captured and the permission service is ready.
     *
     * `rootSession` is set only from a UI-present `session_start` with a
     * non-empty captured session id, so a headless or in-process subagent child
     * that can still resolve the published parent service never registers.
     * Either the extension or the permission system may start first; whichever
     * satisfies the second condition completes registration.
     */
    function tryRegister(): void {
        if (disposeAuthorizer || !rootSession) {
            return;
        }

        const service = getPermissionsService();
        if (!service) {
            return;
        }

        const { session, sessionId } = rootSession;
        disposeAuthorizer = service.registerAuthorizer(
            LINK_NAME,
            async (details, query, log) =>
                authorizeInnerCommand({
                    details,
                    query,
                    log,
                    session,
                    expectedSessionId: sessionId,
                }),
        );
    }

    pi.on("session_start", (_event, ctx) => {
        // Root-ownership gate: register only from the proven UI-present root.
        // Headless/in-process children resolve the parent's process-global
        // service but must not register with child-captured context.
        if (!ctx.hasUI) {
            return;
        }

        // Snapshot the session identity as registration provenance. A non-empty
        // id is required so authorization can revalidate ownership later;
        // without it, do not register.
        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId) {
            return;
        }

        rootSession = { session: ctx.sessionManager, sessionId };
        tryRegister();
    });

    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
        tryRegister();
    });

    pi.on("session_shutdown", () => {
        disposeAuthorizer?.();
        disposeAuthorizer = undefined;
        rootSession = undefined;
    });
}
