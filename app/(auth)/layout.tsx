"use client";

import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { ZLUTTY_EASINGS, ZLUTTY_DURATIONS } from "@/lib/animations/utils";
import { useReducedMotion } from "@/lib/animations/hooks";
import { useTranslations } from "next-intl";
import { WindowsTitleBar } from "@/components/layout/windows-titlebar";
import { DevLogsViewer } from "@/components/dev/dev-logs-viewer";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const t = useTranslations("authLayout");

  // Entrance animation
  useEffect(() => {
    if (!containerRef.current || prefersReducedMotion) return;

    animate(containerRef.current, {
      opacity: [0, 1],
      translateY: [30, 0],
      duration: ZLUTTY_DURATIONS.normal,
      ease: ZLUTTY_EASINGS.reveal,
    });
  }, [prefersReducedMotion]);

  // Ambient logo animation
  useEffect(() => {
    if (!logoRef.current || prefersReducedMotion) return;

    const anim = animate(logoRef.current, {
      rotateY: [-3, 3, -3],
      translateY: [-2, 2, -2],
      duration: ZLUTTY_DURATIONS.ambientLoop,
      loop: true,
      ease: ZLUTTY_EASINGS.float,
    });

    return () => {
      anim.pause();
    };
  }, [prefersReducedMotion]);

  return (
    <div className="flex min-h-screen flex-col bg-terminal-cream">
      <WindowsTitleBar />
      <div className="flex flex-1 items-center justify-center">
        <div
          ref={containerRef}
          className="w-full max-w-md space-y-8 px-4 transform-gpu"
          style={{ opacity: prefersReducedMotion ? 1 : 0 }}
        >
          {/* Logo */}
          <div className="flex justify-center">
            <div
              ref={logoRef}
              className="flex items-center gap-3 transform-gpu"
              style={{ perspective: "500px" }}
            >
              <img
                src="/icon.png"
                alt="Selene"
                className="h-12 w-12 object-contain rounded-[22%]"
              />
              <span className="text-2xl font-semibold font-mono text-terminal-dark">{t("logo")}</span>
            </div>
          </div>

          {/* Auth form container */}
          <div className="border border-terminal-border rounded-lg p-6 bg-terminal-cream/50 backdrop-blur-sm">
            {children}
          </div>
        </div>
      </div>
      <DevLogsViewer />
    </div>
  );
}

