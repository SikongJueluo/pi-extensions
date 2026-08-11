import type {
    ExtensionAPI,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";
import {
    NATIVE_BASH_TOOL_NAME,
    recoverNativeBashCommand,
} from "@sikongjueluo/pi-permission-shared";

const LINK_NAME = "ai-bash-judge";

/** 捕获的 UI-root 会话读取入口，用于还原完整命令。 */
interface CapturedSession {
    getEntries(): ReadonlyArray<SessionEntry>;
}

export default function permissionAiJudge(pi: ExtensionAPI): void {
    let session: CapturedSession | undefined;
    let disposeAuthorizer: (() => void) | undefined;

    /**
     * 尝试向 pi-permission-system 注册我们的 Authorizer。
     *
     * 之所以不能只在 session_start 里注册，是因为：
     * - 可能我们的 extension 先启动；
     * - 也可能 pi-permission-system 先启动。
     *
     * 所以同时监听 session_start 和 permissions:ready，
     * 谁后满足条件，谁完成注册。
     */
    function tryRegister(): void {
        if (!session || disposeAuthorizer) {
            return;
        }

        const service = getPermissionsService();

        if (!service) {
            console.debug(
                `[${LINK_NAME}] permission service not ready; waiting`,
            );
            return;
        }

        // 捕获此刻的会话引用：回调触发时读取最新 entries。
        const captured = session;

        disposeAuthorizer = service.registerAuthorizer(
            LINK_NAME,

            async (details, query, log) => {
                const surface =
                    details.accessIntent?.surface ??
                    details.surface ??
                    undefined;

                /**
                 * 还原完整的 bash 命令。
                 *
                 * details.command 可能只是聚合 ask 里的某个命令单元（见
                 * ADR 0001），AI 判定需要完整输入。只有原生 bash 工具调用
                 * 才能从会话里还原；否则回退到 details.command。
                 */
                const command =
                    details.toolName === NATIVE_BASH_TOOL_NAME &&
                    details.toolCallId !== undefined
                        ? recoverNativeBashCommand(
                              captured.getEntries(),
                              details.toolCallId,
                          )
                        : undefined;

                const effectiveCommand = command ?? details.command;

                console.error(`[${LINK_NAME}] permission ask received`, {
                    requestId: details.requestId,
                    surface,
                    toolName: details.toolName,
                    command: effectiveCommand ?? null,
                    path: details.path,
                    value: details.value,
                    agentName: details.agentName,
                });

                /**
                 * 测试 PermissionQuery。
                 *
                 * 这不会再次触发 Authorizer。
                 * 它只是询问 pi-permission-system 的确定性规则：
                 * “如果检查这个 bash command，规则本身会怎么判？”
                 */
                if (surface === "bash" && effectiveCommand) {
                    const result = query.checkPermission(
                        "bash",
                        effectiveCommand,
                        details.agentName ?? undefined,
                    );

                    console.error(
                        `[${LINK_NAME}] deterministic policy says`,
                        result,
                    );
                }

                /**
                 * 写入 permission-system 自己的 review log。
                 *
                 * 以后 AI 的 decision trail 也应该写这里。
                 */
                log.review("ai_bash_judge.test", {
                    requestId: details.requestId,
                    surface,
                    command: effectiveCommand ?? null,
                    verdict: "defer",
                });

                /**
                 * 第一版永远不审批。
                 *
                 * defer = 我不知道 / 我不处理，
                 * 请 Authorizer Chain 继续交给下一个审批者。
                 *
                 * 正常情况下最终就是 LocalUserAuthorizer，
                 * 所以你还是会看到原来的 permission prompt。
                 */
                return {
                    kind: "defer",
                };
            },
        );

        console.error(`[${LINK_NAME}] registered`);
    }

    pi.on("session_start", (_event, ctx) => {
        // 仅从 proven UI-present root 注册：headless / 进程内 subagent child
        // 能解析到父进程的 service，但不能用 child 捕获的上下文注册，
        // 否则还原出的命令会来自错误的会话。
        if (!ctx.hasUI) {
            return;
        }

        session = ctx.sessionManager;
        tryRegister();
    });

    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
        tryRegister();
    });

    pi.on("session_shutdown", () => {
        disposeAuthorizer?.();

        disposeAuthorizer = undefined;
        session = undefined;

        console.error(`[${LINK_NAME}] unregistered`);
    });
}
