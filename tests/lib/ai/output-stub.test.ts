/**
 * Tests for buildOutputStub — specifically the retrievalToolLoaded flag added
 * in Phase 1 of the model-looping fix.
 */
import { describe, it, expect } from "vitest";
import { buildOutputStub } from "@/lib/ai/output-stub";

const SAMPLE_TEXT = `line A
line B
line C
line D
line E`;

describe("buildOutputStub — retrievalToolLoaded flag", () => {
  it("retrievalToolLoaded=true (default) does NOT emit step-0 for logId", () => {
    const stub = buildOutputStub({
      toolName: "bash",
      originalText: SAMPLE_TEXT,
      retrievalId: "log_abc123",
      idType: "logId",
      retrievalToolLoaded: true,
    });

    expect(stub).toContain("[STUB:");
    expect(stub).toContain("executeCommand({ command: \"readLog\"");
    // Step-0 must NOT be present
    expect(stub).not.toMatch(/Step 0.*MANDATORY/i);
    expect(stub).not.toContain("searchTools({ query:");
  });

  it("retrievalToolLoaded=false emits mandatory step-0 for logId", () => {
    const stub = buildOutputStub({
      toolName: "bash",
      originalText: SAMPLE_TEXT,
      retrievalId: "log_abc123",
      idType: "logId",
      retrievalToolLoaded: false,
    });

    expect(stub).toContain("[STUB:");
    // Step-0 must be present
    expect(stub).toContain("Step 0 (MANDATORY)");
    expect(stub).toContain('searchTools({ query: "select:executeCommand" })');
    expect(stub).toContain("Step 1 (AFTER loading)");
    // Retrieval calls still present, after step-0
    expect(stub).toContain("executeCommand({ command: \"readLog\"");
    expect(stub).toContain("Retrieval calls (usable after step 0):");
    // The warning about the tool not being loaded
    expect(stub).toContain("executeCommand is NOT currently in your active tool set");
  });

  it("retrievalToolLoaded=false emits mandatory step-0 for contentId", () => {
    const stub = buildOutputStub({
      toolName: "readFile",
      originalText: SAMPLE_TEXT,
      retrievalId: "trunc_xyz",
      idType: "contentId",
      retrievalToolLoaded: false,
    });

    expect(stub).toContain("Step 0 (MANDATORY)");
    expect(stub).toContain('searchTools({ query: "select:retrieveFullContent" })');
    expect(stub).toContain("retrieveFullContent is NOT currently in your active tool set");
    expect(stub).toContain("retrieveFullContent({ contentId:");
  });

  it("retrievalToolLoaded=true (default) does NOT emit step-0 for contentId", () => {
    const stub = buildOutputStub({
      toolName: "readFile",
      originalText: SAMPLE_TEXT,
      retrievalId: "trunc_xyz",
      idType: "contentId",
      retrievalToolLoaded: true,
    });

    expect(stub).not.toMatch(/Step 0.*MANDATORY/i);
    expect(stub).not.toContain("searchTools({ query:");
    expect(stub).toContain("retrieveFullContent({ contentId:");
  });

  it("default behavior (retrievalToolLoaded omitted) is backwards-compatible", () => {
    const stub = buildOutputStub({
      toolName: "bash",
      originalText: SAMPLE_TEXT,
      retrievalId: "log_def",
      idType: "logId",
      // retrievalToolLoaded NOT passed → defaults to true
    });

    // Same as retrievalToolLoaded=true — no step-0
    expect(stub).not.toMatch(/Step 0.*MANDATORY/i);
    expect(stub).toContain("executeCommand({ command: \"readLog\"");
    expect(stub).toContain("Only call readLog");
  });

  it("no retrievalId still works regardless of flag", () => {
    const stub = buildOutputStub({
      toolName: "bash",
      originalText: SAMPLE_TEXT,
      retrievalToolLoaded: false,
    });

    expect(stub).toContain("Full output NOT stored");
    expect(stub).not.toContain("Step 0");
  });
});
