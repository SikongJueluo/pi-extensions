/**
 * Narrow built-in high-risk override (ADR 0008; PIEXTENSIO-23).
 *
 * A deterministic preflight that recognizes clear-cut command shapes in
 * four categories and always defers them to the human dialog:
 *
 * - `data_loss` / `history_rewrite`: the ADR 0007 enumerated irreversible
 *   shapes (git clean -xfd, git reset --hard, git checkout/restore .,
 *   git push --force, rm -rf against home/root targets);
 * - `publish_deploy`: package publishing and infrastructure destruction
 *   (npm/pnpm/yarn/cargo publish, terraform destroy);
 * - `system_modify`: privilege escalation and system-level modification
 *   (sudo, mkfs, dd onto devices, shutdown/reboot/halt/poweroff);
 * - `credential_access`: direct read/output/delete/replace of well-known
 *   credential files (~/.ssh/id_*, authorized_keys, ~/.aws/credentials,
 *   ~/.netrc, ~/.gnupg, gcloud application-default credentials), including
 *   redirect writes (`>`, `>>`, `N>`) and `tee`.
 *
 * Scanning is quote-, escape-, and separator-aware (`;`, `&&`, `||`, `|`,
 * `&`, newlines outside quotes split units), so ordinary compound inputs
 * are neither bypassed (`echo ready & npm publish`) nor false-positived
 * (`printf 'x; npm publish;'`). Deliberately NOT a sandbox: only
 * well-known explicit command shapes are matched. No alias resolution,
 * no script-content analysis, no variable expansion, no "every opaque
 * command defers" rule, and no user-facing `alwaysPrompt` config.
 * Behavior: in Enforce a hit skips the model and defers immediately with
 * code `high_risk_override`; in Shadow the model is still called (quality
 * observation) and the override is recorded.
 */

export type HighRiskCategory =
    | "data_loss"
    | "history_rewrite"
    | "publish_deploy"
    | "system_modify"
    | "credential_access";

export interface HighRiskMatch {
    readonly category: HighRiskCategory;
    readonly rule: string;
}

/** Characters that separate command units when unquoted and unescaped. */
const UNIT_SEPARATORS = new Set([";", "|", "&", "\n"]);
/** Output-redirection operators, emitted as standalone tokens (`>`, `>>`, `2>`). */
const REDIRECT_OP = /^(?:\d+)?>{1,2}$/;

/**
 * Scan a complete Bash input into units of tokens. Single- and
 * double-quoted segments become one token (quotes stripped); backslash
 * escapes are taken literally; separators inside quotes or escapes do
 * not split. Collapsed operators (`&&`, `||`) produce empty units that
 * are dropped. This is lexical hygiene only — no alias, variable, or
 * substitution semantics.
 */
function scanCommand(command: string): string[][] {
    const units: string[][] = [];
    let tokens: string[] = [];
    let current = "";
    let quote: string | null = null;

    const pushToken = (): void => {
        if (current.length > 0) {
            tokens.push(current);
            current = "";
        }
    };
    const pushUnit = (): void => {
        pushToken();
        if (tokens.length > 0) {
            units.push(tokens);
            tokens = [];
        }
    };

    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i];
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            pushToken();
            quote = ch;
            continue;
        }
        if (ch === "\\") {
            current += command[i + 1] ?? "";
            i += 1;
            continue;
        }
        if (UNIT_SEPARATORS.has(ch)) {
            pushUnit();
            continue;
        }
        if (ch === ">") {
            const fd = /^\d+$/.exec(current);
            pushToken();
            let op = fd === null ? ">" : `${fd[0]}>`;
            if (command[i + 1] === ">") {
                op += ">";
                i += 1;
            }
            tokens.push(op);
            continue;
        }
        if (/\s/.test(ch)) {
            pushToken();
            continue;
        }
        current += ch;
    }
    pushUnit();
    return units;
}

/** Combined single-letter git flags, e.g. `-xfd` → has x, f, d. */
function shortFlagLetters(token: string): Set<string> {
    const letters = new Set<string>();
    if (!/^-[a-zA-Z]+$/.test(token)) {
        return letters;
    }
    for (const letter of token.slice(1)) {
        letters.add(letter);
    }
    return letters;
}

function hasGitFlag(args: string[], letter: string, long: string): boolean {
    for (const arg of args) {
        if (arg === `--${long}`) {
            return true;
        }
        if (shortFlagLetters(arg).has(letter)) {
            return true;
        }
    }
    return false;
}

function classifyGit(args: string[]): HighRiskMatch | undefined {
    const subcommand = args[0];
    const rest = args.slice(1);
    switch (subcommand) {
        case "clean": {
            // git clean with force + ignored-file removal (-f/-x/-d shapes).
            // Dry-run (-n) never matches.
            const hasDryRun = rest.some((arg) => arg === "-n" || shortFlagLetters(arg).has("n"));
            const force = hasGitFlag(rest, "f", "force");
            const ignored = hasGitFlag(rest, "x", "x") || rest.includes("-x");
            if (force && ignored && !hasDryRun) {
                return { category: "data_loss", rule: "git_clean_forced_x" };
            }
            return undefined;
        }
        case "reset":
            if (rest.includes("--hard")) {
                return { category: "data_loss", rule: "git_reset_hard" };
            }
            return undefined;
        case "checkout":
        case "restore": {
            // Whole-tree discard: `git checkout -- .` / `git checkout .` /
            // `git restore .` (optionally `--worktree`-style flags first).
            const positional = rest.filter((arg) => !arg.startsWith("-"));
            const dotIndex = positional.lastIndexOf(".");
            if (dotIndex !== -1 && positional.slice(dotIndex).every((arg) => arg === ".")) {
                return {
                    category: "data_loss",
                    rule: subcommand === "checkout" ? "git_checkout_dot" : "git_restore_dot",
                };
            }
            return undefined;
        }
        case "push": {
            const forced =
                rest.includes("--force") ||
                rest.includes("-f") ||
                rest.includes("--force-with-lease") ||
                rest.some((arg) => arg.startsWith("+") && arg.length > 1);
            if (forced) {
                return { category: "history_rewrite", rule: "git_push_force" };
            }
            return undefined;
        }
        default:
            return undefined;
    }
}

function classifyRm(args: string[]): HighRiskMatch | undefined {
    const recursive = args.some((arg) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg) || arg === "-r" || arg === "-R" || arg === "--recursive");
    const forced = hasGitFlag(args, "f", "force");
    if (!recursive || !forced) {
        return undefined;
    }
    const targets = args.filter((arg) => !arg.startsWith("-") && !REDIRECT_OP.test(arg));
    const dangerous = targets.some(
        (target) =>
            target === "/" ||
            target === "~" ||
            target === "$HOME" ||
            target.startsWith("/*") ||
            target.startsWith("~/") ||
            target.startsWith("~") ||
            target.startsWith("$HOME/"),
    );
    return dangerous
        ? { category: "data_loss", rule: "rm_rf_home_or_root" }
        : undefined;
}

function classifyPublish(head: string, args: string[]): HighRiskMatch | undefined {
    const sub = args[0];
    switch (head) {
        case "npm":
        case "pnpm":
        case "yarn":
        case "cargo":
            if (sub === "publish") {
                return { category: "publish_deploy", rule: `${head}_publish` };
            }
            return undefined;
        case "terraform":
            if (sub === "destroy") {
                return { category: "publish_deploy", rule: "terraform_destroy" };
            }
            return undefined;
        default:
            return undefined;
    }
}

function classifySystem(head: string, args: string[]): HighRiskMatch | undefined {
    if (head === "sudo") {
        return { category: "system_modify", rule: "sudo" };
    }
    if (head.startsWith("mkfs")) {
        return { category: "system_modify", rule: "mkfs" };
    }
    if (head === "shutdown" || head === "reboot" || head === "halt" || head === "poweroff") {
        return { category: "system_modify", rule: head };
    }
    if (head === "dd") {
        if (args.some((arg) => /^of=\/dev\//.test(arg))) {
            return { category: "system_modify", rule: "dd_to_device" };
        }
    }
    return undefined;
}

/** Read/alter verbs that touch a credential path directly. */
const CREDENTIAL_VERBS = new Set([
    "cat",
    "less",
    "more",
    "head",
    "tail",
    "bat",
    "zcat",
    "tee",
    "cp",
    "mv",
    "rm",
    "install",
    "scp",
    "rsync",
]);

const CREDENTIAL_PATH_PATTERNS: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
    { pattern: /^~\/\.ssh\/id_./, rule: "ssh_private_key" },
    { pattern: /^~\/\.ssh\/authorized_keys/, rule: "ssh_authorized_keys" },
    { pattern: /^~\/\.aws\/credentials/, rule: "aws_credentials" },
    { pattern: /^~\/\.netrc/, rule: "netrc" },
    { pattern: /^~\/\.gnupg(\/|$)/, rule: "gnupg" },
    {
        pattern: /^~\/\.config\/gcloud\/application_default_credentials/,
        rule: "gcloud_default_credentials",
    },
    { pattern: /^\$HOME\/\.ssh\/id_./, rule: "ssh_private_key" },
    { pattern: /^\$HOME\/\.ssh\/authorized_keys/, rule: "ssh_authorized_keys" },
    { pattern: /^\$HOME\/\.aws\/credentials/, rule: "aws_credentials" },
    { pattern: /^\$HOME\/\.netrc/, rule: "netrc" },
    { pattern: /^\$HOME\/\.gnupg(\/|$)/, rule: "gnupg" },
];

function matchCredentialPath(
    value: string,
): { rule: string } | undefined {
    for (const { pattern, rule } of CREDENTIAL_PATH_PATTERNS) {
        if (pattern.test(value)) {
            return { rule };
        }
    }
    return undefined;
}

function classifyCredential(args: string[]): HighRiskMatch | undefined {
    for (const arg of args) {
        if (arg.startsWith("-") || REDIRECT_OP.test(arg)) {
            continue;
        }
        const match = matchCredentialPath(arg);
        if (match !== undefined) {
            return { category: "credential_access", rule: match.rule };
        }
    }
    return undefined;
}

/**
 * Direct credential replacement via output redirection — any verb writing
 * a credential path (`>`, `>>`, fd-prefixed). Checked per unit regardless
 * of the leading verb, since `echo x > ~/.aws/credentials` replaces the
 * credential whatever the writer is.
 */
function classifyCredentialRedirect(tokens: string[]): HighRiskMatch | undefined {
    for (let i = 0; i < tokens.length; i += 1) {
        if (!REDIRECT_OP.test(tokens[i])) {
            continue;
        }
        const target = tokens[i + 1];
        if (target === undefined) {
            continue;
        }
        const match = matchCredentialPath(target);
        if (match !== undefined) {
            return {
                category: "credential_access",
                rule: `${match.rule}_redirect_write`,
            };
        }
    }
    return undefined;
}

/**
 * Classify a complete Bash input against the built-in high-risk shapes.
 * Any matching unit marks the whole input; the first match wins.
 */
export function classifyHighRisk(fullCommand: string): HighRiskMatch | undefined {
    for (const tokens of scanCommand(fullCommand)) {
        const [head, ...args] = tokens;
        const match =
            classifyCredentialRedirect(tokens) ??
            (CREDENTIAL_VERBS.has(head) ? classifyCredential(args) : undefined) ??
            classifySystem(head, args) ??
            (head === "git" ? classifyGit(args) : undefined) ??
            (head === "rm" ? classifyRm(args) : undefined) ??
            classifyPublish(head, args);
        if (match !== undefined) {
            return match;
        }
    }
    return undefined;
}
