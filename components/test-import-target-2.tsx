"use client";

export default function TestImportTarget2() {
  return (
    <div
      style={{
        padding: 32,
        background: "#0f172a",
        color: "#22d3ee",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        borderRadius: 12,
      }}
    >
      Second test target — different sourcePath, should get a new componentId.
    </div>
  );
}
