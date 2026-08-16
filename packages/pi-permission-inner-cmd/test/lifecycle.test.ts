import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionStartEvent,
    SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index";
import {
    PERMISSIONS_READY_CHANNEL,
    publishPermissionsService,
    unpublishPermissionsService,
    type Authorizer,
    type PermissionsService,
} from "@gotgenes/pi-permission-system";

/**
 * Minimal fake ExtensionAPI that records the lifecycle handlers the extension
 * uses. Cast to ExtensionAPI because the factory only touches a small surface.
 */
function createFakePi(): {
    pi: ExtensionAPI;
    fireSessionStart: (
        sessionManager: ExtensionContext["sessionManager"],
        hasUI?: boolean,
    ) => void;
    fireSessionShutdown: () => void;
    readyHandlers: Array<() => unknown>;
} {
    const sessionStartHandlers: Array<
        (event: SessionStartEvent, ctx: ExtensionContext) => unknown
    > = [];
    const shutdownHandlers: Array<(event: SessionShutdownEvent) => unknown> = [];
    const readyHandlers: Array<() => unknown> = [];

    const pi = {
        on(event: string, handler: (...args: never[]) => unknown): void {
            if (event === "session_start") sessionStartHandlers.push(handler as never);
            else if (event === "session_shutdown")
                shutdownHandlers.push(handler as never);
        },
        events: {
            on(channel: string, handler: (...args: never[]) => unknown): void {
                if (channel === PERMISSIONS_READY_CHANNEL)
                    readyHandlers.push(handler as never);
            },
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        fireSessionStart: (sessionManager, hasUI = true) => {
            const ctx = { sessionManager, hasUI } as unknown as ExtensionContext;
            const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
            for (const handler of sessionStartHandlers) handler(event, ctx);
        },
        fireSessionShutdown: () => {
            const event = { type: "session_shutdown" } as SessionShutdownEvent;
            for (const handler of shutdownHandlers) handler(event);
        },
        readyHandlers,
    };
}

/**
 * A fake session manager whose entries and identity can be inspected for
 * assertions. Defaults to a UI-root-shaped non-empty session id.
 */
function createFakeSessionManager(
    entries: unknown[] = [],
    sessionId = "session-root",
) {
    return {
        getEntries: () => entries,
        getSessionId: () => sessionId,
    } as unknown as ExtensionContext["sessionManager"];
}

describe("permissions:ready -> registerAuthorizer lifecycle", () => {
    let registerAuthorizer: ReturnType<typeof vi.fn>;
    let disposer: ReturnType<typeof vi.fn>;
    let service: PermissionsService;
    let authorize: Authorizer["authorize"] | undefined;
    let published: boolean;

    beforeEach(() => {
        disposer = vi.fn();
        authorize = undefined;
        registerAuthorizer = vi.fn((name, callback) => {
            authorize = callback;
            return disposer;
        });
        service = {
            registerAuthorizer,
            checkPermission: () => ({
                toolName: "bash",
                state: "ask",
                source: "bash",
                origin: "builtin",
            }),
            getToolPermission: () => "ask",
        } as unknown as PermissionsService;
        published = false;
    });

    afterEach(() => {
        if (published) unpublishPermissionsService(service);
    });

    /**
     * Model the permission system becoming ready: it publishes its service and
     * then emits the `permissions:ready` channel. Before this, no service is
     * available, so an early `session_start` cannot register yet.
     */
    function becomeReady(): void {
        publishPermissionsService(service);
        published = true;
    }

    it("waits for the service: session_start alone does not register", () => {
        const { pi, fireSessionStart } = createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager());
        expect(registerAuthorizer).not.toHaveBeenCalled();
    });

    it("registers once the service becomes ready after session_start", () => {
        const { pi, fireSessionStart, readyHandlers } = createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager());
        expect(registerAuthorizer).not.toHaveBeenCalled();

        becomeReady();
        for (const handler of readyHandlers) handler();
        expect(registerAuthorizer).toHaveBeenCalledTimes(1);
        expect(registerAuthorizer).toHaveBeenCalledWith(
            "inner-cmd",
            expect.any(Function),
        );
    });

    it("registers immediately at session_start when the service is already ready", () => {
        const { pi, fireSessionStart } = createFakePi();
        extension(pi);

        becomeReady();
        fireSessionStart(createFakeSessionManager());
        expect(registerAuthorizer).toHaveBeenCalledTimes(1);
    });

    it("needs a session: ready without session_start does not register", () => {
        const { pi, readyHandlers } = createFakePi();
        extension(pi);

        becomeReady();
        for (const handler of readyHandlers) handler();
        expect(registerAuthorizer).not.toHaveBeenCalled();
    });

    it("does not register from a headless (hasUI=false) session_start", () => {
        // An in-process/headless child can resolve the published parent service
        // but must never register with child-captured context.
        const { pi, fireSessionStart, readyHandlers } = createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager(), false);
        becomeReady();
        for (const handler of readyHandlers) handler();
        expect(registerAuthorizer).not.toHaveBeenCalled();
    });

    it("does not register when the captured session id is empty", () => {
        // Without a non-empty identity snapshot there is no provenance to
        // revalidate at authorize time, so registration is refused.
        const { pi, fireSessionStart, readyHandlers } = createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager([], ""));
        becomeReady();
        for (const handler of readyHandlers) handler();
        expect(registerAuthorizer).not.toHaveBeenCalled();
    });

    it("does not re-register on a second readiness signal", () => {
        const { pi, fireSessionStart, readyHandlers } = createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager());
        becomeReady();
        for (const handler of readyHandlers) handler();
        for (const handler of readyHandlers) handler();

        expect(registerAuthorizer).toHaveBeenCalledTimes(1);
    });

    it("disposes the authorizer on session_shutdown and re-registers after", () => {
        const { pi, fireSessionStart, fireSessionShutdown, readyHandlers } =
            createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager());
        becomeReady();
        for (const handler of readyHandlers) handler();
        expect(disposer).not.toHaveBeenCalled();

        fireSessionShutdown();
        expect(disposer).toHaveBeenCalledTimes(1);

        // A fresh session cycle registers again.
        fireSessionStart(createFakeSessionManager());
        for (const handler of readyHandlers) handler();
        expect(registerAuthorizer).toHaveBeenCalledTimes(2);
    });

    it("registers a callback that defers forwarded asks fail-closed", async () => {
        const { pi, fireSessionStart, readyHandlers } = createFakePi();
        extension(pi);

        fireSessionStart(createFakeSessionManager());
        becomeReady();
        for (const handler of readyHandlers) handler();
        expect(authorize).toBeDefined();

        const verdict = await authorize!(
            {
                requestId: "req-1",
                source: "tool_call",
                agentName: "child",
                message: "forwarded ask",
                payload: {
                    kind: "forwarded",
                    request: {
                        requester: {
                            agentName: "child",
                            forwarded: true,
                            sessionId: "s1",
                        },
                        surface: "bash",
                        toolName: "bash",
                        invokedToolName: null,
                        value: "bash",
                        matchedPattern: null,
                        commandContext: null,
                        executedUnit: null,
                    },
                    evidence: [
                        {
                            label: "requested",
                            text: "forwarded ask",
                            detail: null,
                        },
                    ],
                    annotations: [],
                },
                toolCallId: "call_1",
                toolName: "bash",
                forwarding: {
                    requesterAgentName: "child",
                    requesterSessionId: "s1",
                },
            },
            {
                checkPermission: () => ({
                    toolName: "bash",
                    state: "allow",
                    source: "bash",
                    origin: "builtin",
                }),
                getToolPermission: () => "allow",
            },
            { review: () => {}, debug: () => {} },
        );

        expect(verdict).toEqual({ kind: "defer" });
    });
});
