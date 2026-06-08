import { afterEach, describe, it, expect } from "vitest";
import { validateCommand, validateExecutionDirectory } from "@/lib/command-execution/validator";

describe("Command Validator Tests", () => {
    afterEach(() => {
        delete process.env.SELENE_UNSAFE_AGENT_PERMISSIONS;
    });
    it("Should allow commands with single quotes", () => {
        expect(validateCommand("echo 'hacked'", []).valid).toBe(true);
    });

    it("Should allow commands with double quotes", () => {
        expect(validateCommand('echo "hacked"', []).valid).toBe(true);
    });

    it("Should allow commands containing semicolon", () => {
        expect(validateCommand("echo; rm -rf", []).valid).toBe(true);
    });

    it("Should allow commands containing &&", () => {
        expect(validateCommand("echo && rm -rf", []).valid).toBe(true);
    });

    it("Should allow commands containing pipe", () => {
        expect(validateCommand("echo | bash", []).valid).toBe(true);
    });

    it("Should allow safe echo", () => {
        expect(validateCommand("echo", ["hello"]).valid).toBe(true);
    });

    it("Should allow safe ls", () => {
        expect(validateCommand("ls", ["-la"]).valid).toBe(true);
    });

    it("Should allow rm without confirmation", () => {
        expect(validateCommand("rm", []).valid).toBe(true);
    });

    it("Should ignore legacy removal confirmation", () => {
        expect(validateCommand("rm", [], { confirmRemoval: true }).valid).toBe(true);
    });

    it("Should allow format", () => {
        expect(validateCommand("format", []).valid).toBe(true);
    });

    it("Should allow format-json", () => {
        expect(validateCommand("format-json", []).valid).toBe(true);
    });

    it("Should allow my-rm-tool", () => {
        expect(validateCommand("my-rm-tool", []).valid).toBe(true);
    });

    it("Should allow performance", () => {
        expect(validateCommand("performance", []).valid).toBe(true);
    });

    it("Should allow .. arg", () => {
        expect(validateCommand("ls", [".."]).valid).toBe(true);
    });

    it("Should allow ../secret arg", () => {
        expect(validateCommand("ls", ["../secret"]).valid).toBe(true);
    });

    it("Should allow .. in flag", () => {
        expect(validateCommand("ls", ["-p=../secret"]).valid).toBe(true);
    });

    it("Should allow .. in long flag", () => {
        expect(validateCommand("ls", ["--path=../secret"]).valid).toBe(true);
    });

    it("Should allow execution inside an allowed workspace worktree", async () => {
        const result = await validateExecutionDirectory(
            "/Users/me/apps/worktrees/feature-x/app",
            ["/Users/me/apps/worktrees/feature-x", "/Users/me/apps/repo"]
        );

        expect(result).toEqual({
            valid: true,
            resolvedPath: "/Users/me/apps/worktrees/feature-x/app",
        });
    });

    it("Should allow any absolute cwd when unsafe agent permissions are enabled", async () => {
        process.env.SELENE_UNSAFE_AGENT_PERMISSIONS = "true";

        const result = await validateExecutionDirectory("/tmp/outside", []);

        expect(result).toEqual({
            valid: true,
            resolvedPath: "/tmp/outside",
        });
    });
});
