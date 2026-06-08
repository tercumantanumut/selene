"use client";

import { useState } from "react";

interface TestImportTargetProps {
  initialCount?: number;
  label?: string;
}

export default function TestImportTarget({
  initialCount = 0,
  label = "Clicks",
}: TestImportTargetProps) {
  const [count, setCount] = useState(initialCount);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 32,
        background: "linear-gradient(135deg, #6366f1, #ec4899)",
        color: "white",
        borderRadius: 16,
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.85, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1 }}>{count}</div>
      <button
        onClick={() => setCount((n) => n + 1)}
        style={{
          padding: "10px 18px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.4)",
          background: "rgba(255,255,255,0.15)",
          color: "white",
          fontWeight: 600,
          cursor: "pointer",
          backdropFilter: "blur(8px)",
        }}
      >
        +1
      </button>
    </div>
  );
}
