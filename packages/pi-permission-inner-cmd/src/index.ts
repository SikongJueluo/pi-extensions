import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";

const LINK_NAME = "inner-cmd";

export default function permissionAiJudge(pi: ExtensionAPI): void {
    let sessionStarted = false;
    let disposeAuthorizer: (() => void) | undefined;

    pi.on("session_start", () => {
        sessionStarted = true;
    });

    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
    });

    pi.on("session_shutdown", () => {
    });
}
