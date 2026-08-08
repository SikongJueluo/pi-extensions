import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";

const LINK_NAME = "ai-bash-judge";

export default function permissionAiJudge(pi: ExtensionAPI): void {
    let sessionStarted = false;
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
        if (!sessionStarted || disposeAuthorizer) {
            return;
        }

        const service = getPermissionsService();

        if (!service) {
            console.debug(
                `[${LINK_NAME}] permission service not ready; waiting`,
            );
            return;
        }

        disposeAuthorizer = service.registerAuthorizer(
            LINK_NAME,

            async (details, query, log) => {
                const surface =
                    details.accessIntent?.surface ??
                    details.surface ??
                    undefined;

                console.error(`[${LINK_NAME}] permission ask received`, {
                    requestId: details.requestId,
                    surface,
                    toolName: details.toolName,
                    command: details.command,
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
                if (surface === "bash" && details.command) {
                    const result = query.checkPermission(
                        "bash",
                        details.command,
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
                    command: details.command ?? null,
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

    pi.on("session_start", () => {
        sessionStarted = true;
        tryRegister();
    });

    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
        tryRegister();
    });

    pi.on("session_shutdown", () => {
        disposeAuthorizer?.();

        disposeAuthorizer = undefined;
        sessionStarted = false;

        console.error(`[${LINK_NAME}] unregistered`);
    });
}
