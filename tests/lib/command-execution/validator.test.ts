import { describe, it, expect } from "vitest";
import { validateCommand, validateExecutionDirectory } from "@/lib/command-execution/validator";

describe("Command Validator Tests", () => {
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

    it("Should require confirmation for rm", () => {
        expect(validateCommand("rm", []).valid).toBe(false);
    });

    it("Should allow rm with explicit confirmation", () => {
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

    it("Should block .. arg", () => {
        expect(validateCommand("ls", [".."]).valid).toBe(false);
    });

    it("Should block ../secret arg", () => {
        expect(validateCommand("ls", ["../secret"]).valid).toBe(false);
    });

    it("Should block .. in flag", () => {
        expect(validateCommand("ls", ["-p=../secret"]).valid).toBe(false);
    });

    it("Should block .. in long flag", () => {
        expect(validateCommand("ls", ["--path=../secret"]).valid).toBe(false);
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
});
