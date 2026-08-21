import { describe, expect, it } from "vitest";
import { classifyHighRisk } from "../src/highrisk";

describe("classifyHighRisk — data_loss", () => {
    it.each([
        "git clean -xfd",
        "git clean -fdx",
        "git clean -fxd",
        "git clean -f -x -d",
        "git clean --force -xd",
        "git reset --hard",
        "git reset --hard HEAD~3",
        "git reset --hard origin/main",
        "git checkout -- .",
        "git checkout .",
        "git restore .",
        "git restore -- .",
        "rm -rf ~",
        "rm -rf /",
        "rm -rf ~/*",
        "rm -rf $HOME",
        "rm -rf $HOME/projects",
        "rm -fr ~",
    ])("flags %j", (command) => {
        expect(classifyHighRisk(command)?.category).toBe("data_loss");
    });

    it.each([
        "git clean -nxd",
        "git clean -nd",
        "git clean -nxfd",
        "git clean -f -x -n",
        "git clean -fd",
        "git clean -xn",
        "git reset --soft HEAD~1",
        "git checkout main",
        "git checkout -- file.txt",
        "git checkout . file.txt",
        "git restore file.txt",
        "rm -rf build/",
        "rm -rf ./dist",
        "rm -r build",
        "rm file.txt",
        "echo git clean -xfd",
        "git status",
    ])("does not flag %j", (command) => {
        expect(classifyHighRisk(command)).toBeUndefined();
    });
});

describe("classifyHighRisk — history_rewrite", () => {
    it.each([
        "git push --force",
        "git push -f",
        "git push --force origin main",
        "git push --force-with-lease origin main",
        "git push origin +main",
    ])("flags %j", (command) => {
        expect(classifyHighRisk(command)?.category).toBe("history_rewrite");
    });

    it.each(["git push origin main", "git push", "git push --tags"])(
        "does not flag %j",
        (command) => {
            expect(classifyHighRisk(command)).toBeUndefined();
        },
    );
});

describe("classifyHighRisk — publish_deploy", () => {
    it.each([
        "npm publish",
        "npm publish --access public",
        "pnpm publish",
        "yarn publish",
        "cargo publish",
        "terraform destroy",
        "terraform destroy -auto-approve",
    ])("flags %j", (command) => {
        expect(classifyHighRisk(command)?.category).toBe("publish_deploy");
    });

    it.each(["npm run publish", "npm install", "pnpm test", "terraform plan", "terraform apply"])(
        "does not flag %j",
        (command) => {
            expect(classifyHighRisk(command)).toBeUndefined();
        },
    );
});

describe("classifyHighRisk — system_modify", () => {
    it.each([
        "sudo rm /etc/hosts",
        "sudo -i",
        "sudo apt-get install ripgrep",
        "mkfs.ext4 /dev/sda1",
        "mkfs /dev/sdb",
        "dd if=/dev/zero of=/dev/sda bs=1M",
        "shutdown now",
        "shutdown -h now",
        "reboot",
        "halt",
        "poweroff",
    ])("flags %j", (command) => {
        expect(classifyHighRisk(command)?.category).toBe("system_modify");
    });

    it.each([
        "dd if=/dev/zero of=/tmp/img bs=1M count=10",
        "echo sudo",
        "cat /etc/hosts",
    ])("does not flag %j", (command) => {
        expect(classifyHighRisk(command)).toBeUndefined();
    });
});

describe("classifyHighRisk — credential_access", () => {
    it.each([
        "cat ~/.ssh/id_rsa",
        "cat ~/.ssh/id_ed25519",
        "less ~/.ssh/id_ed25519",
        "cat ~/.aws/credentials",
        "head ~/.netrc",
        "cat ~/.config/gcloud/application_default_credentials.json",
        "rm ~/.ssh/id_ed25519",
        "mv ~/.ssh/authorized_keys /tmp",
        "cp ~/.gnupg/secring.gpg .",
        "cat $HOME/.ssh/id_rsa",
        "cat $HOME/.aws/credentials",
    ])("flags %j", (command) => {
        expect(classifyHighRisk(command)?.category).toBe("credential_access");
    });

    it.each([
        "echo x > ~/.aws/credentials",
        "echo x >> ~/.ssh/authorized_keys",
        "ssh-keygen foo 2> ~/.aws/credentials",
        "printf '%s' key > ~/.ssh/id_ed25519",
        "curl -s url | tee ~/.netrc",
    ])("flags credential replacement %j", (command) => {
        expect(classifyHighRisk(command)).toMatchObject({
            category: "credential_access",
        });
    });

    it.each([
        "cat ~/.ssh/config",
        "cat ~/.ssh/known_hosts",
        "cat package.json",
        "ls ~/.ssh",
        "cat ~/.bashrc",
        "cat id_rsa",
        "echo x > ~/.bashrc",
        "curl -s url | tee notes.txt",
    ])("does not flag %j", (command) => {
        expect(classifyHighRisk(command)).toBeUndefined();
    });
});

describe("classifyHighRisk — compound inputs", () => {
    it("flags when any unit matches", () => {
        expect(classifyHighRisk("pnpm test && git clean -xfd")?.category).toBe(
            "data_loss",
        );
        expect(classifyHighRisk("git push --force; echo done")?.category).toBe(
            "history_rewrite",
        );
        expect(classifyHighRisk("npm publish | tee log")?.category).toBe(
            "publish_deploy",
        );
    });

    it("flags single-`&` background compound units", () => {
        expect(classifyHighRisk("echo ready & npm publish")?.category).toBe(
            "publish_deploy",
        );
        expect(classifyHighRisk("sleep 5 & rm -rf ~")?.category).toBe(
            "data_loss",
        );
    });

    it("does not flag separators inside quotes or escapes", () => {
        expect(classifyHighRisk("printf 'x; npm publish;'")).toBeUndefined();
        expect(classifyHighRisk("echo \"git push --force\"")).toBeUndefined();
        expect(classifyHighRisk("echo git\\;npm\\;publish")).toBeUndefined();
        expect(classifyHighRisk("echo 'rm -rf ~'")).toBeUndefined();
    });

    it("treats a quoted command argument as one token, not a command", () => {
        // git commit -m "junk; sudo rm /" quotes an argument, not a unit.
        expect(classifyHighRisk("git commit -m 'do not npm publish'")).toBeUndefined();
    });

    it("flags high-risk units even when another unit quotes text", () => {
        expect(classifyHighRisk("echo 'a;b' && git push --force")).toMatchObject({
            category: "history_rewrite",
        });
    });

    it("returns undefined for all-benign compounds", () => {
        expect(classifyHighRisk("pnpm test && pnpm check")).toBeUndefined();
        expect(classifyHighRisk("echo a; echo b | wc -l")).toBeUndefined();
        expect(classifyHighRisk("sleep 5 & echo done")).toBeUndefined();
    });

    it("reports the matching rule for audit observability", () => {
        const match = classifyHighRisk("git clean -xfd");
        expect(match).toMatchObject({
            category: "data_loss",
            rule: expect.stringMatching(/^git_clean/),
        });
    });
});
