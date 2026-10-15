import { describe, expect, it } from "vitest";
import { parseChannelCommand, isStopCommand, isNewSessionCommand } from "../command-parser";

describe("parseChannelCommand", () => {
  it("parses existing commands", () => {
    expect(parseChannelCommand("/status")).toEqual({ name: "status", args: "" });
    expect(parseChannelCommand("/tts on")).toEqual({ name: "tts", args: "on" });
    expect(parseChannelCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseChannelCommand("/stop")).toEqual({ name: "stop", args: "" });
  });

  it("parses session management commands", () => {
    expect(parseChannelCommand("/sessions")).toEqual({ name: "sessions", args: "" });
    expect(parseChannelCommand("/switch 2")).toEqual({ name: "switch", args: "2" });
    expect(parseChannelCommand("/delete 3 confirm")).toEqual({ name: "delete", args: "3 confirm" });
    expect(parseChannelCommand("/current")).toEqual({ name: "current", args: "" });
    expect(parseChannelCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseChannelCommand("/cancel")).toEqual({ name: "cancel", args: "" });
  });

  it("normalizes /list to sessions", () => {
    expect(parseChannelCommand("/list")).toEqual({ name: "sessions", args: "" });
  });

  it("supports bang prefix and @botname suffix", () => {
    expect(parseChannelCommand("!sessions")).toEqual({ name: "sessions", args: "" });
    expect(parseChannelCommand("/switch@my_bot 4")).toEqual({ name: "switch", args: "4" });
    expect(parseChannelCommand("/HELP@Some_Bot")).toEqual({ name: "help", args: "" });
  });

  it("ignores non-command and unknown text", () => {
    expect(parseChannelCommand("hello /sessions")).toBeNull();
    expect(parseChannelCommand("/unknown")).toBeNull();
    expect(parseChannelCommand("/new")).toBeNull(); // handled by isNewSessionCommand
    expect(parseChannelCommand("")).toBeNull();
    expect(parseChannelCommand("sessions")).toBeNull();
  });

  it("trims and lowercases command names but preserves arg content", () => {
    expect(parseChannelCommand("  /Switch  abc123def  ")).toEqual({ name: "switch", args: "abc123def" });
  });
});

describe("isStopCommand / isNewSessionCommand", () => {
  it("detects stop and new commands", () => {
    expect(isStopCommand("/stop")).toBe(true);
    expect(isStopCommand("!stop@bot")).toBe(true);
    expect(isStopCommand("/stop now")).toBe(false);
    expect(isNewSessionCommand("/new")).toBe(true);
    expect(isNewSessionCommand("/new@bot")).toBe(true);
    expect(isNewSessionCommand("/news")).toBe(false);
  });
});
