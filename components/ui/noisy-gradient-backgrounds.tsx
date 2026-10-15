"use client";

import { useRef, useEffect } from "react";

interface NoiseProps {
    patternSize?: number;
    patternScaleX?: number;
    patternScaleY?: number;
    patternRefreshInterval?: number;
    patternAlpha?: number;
    intensity?: number;
}

function Noise({
    patternSize = 100,
    patternScaleX = 1,
    patternScaleY = 1,
    patternRefreshInterval = 1,
    patternAlpha = 50,
    intensity = 1,
}: NoiseProps) {
    const grainRef = useRef<HTMLCanvasElement>(null);
    const canvasCssSizeRef = useRef({ width: 0, height: 0 });

    useEffect(() => {
        const canvas = grainRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let frame = 0;
        let hasPattern = false;
        const patternCanvas = document.createElement("canvas");
        patternCanvas.width = patternSize;
        patternCanvas.height = patternSize;

        const patternCtx = patternCanvas.getContext("2d");
        if (!patternCtx) return;

        const patternData = patternCtx.createImageData(patternSize, patternSize);
        const patternPixelDataLength = patternSize * patternSize * 4;

        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            let newCssWidth = window.innerWidth;
            let newCssHeight = window.innerHeight;

            if (canvas.parentElement) {
                const parentRect = canvas.parentElement.getBoundingClientRect();
                newCssWidth = parentRect.width;
                newCssHeight = parentRect.height;
            }

            canvasCssSizeRef.current = { width: newCssWidth, height: newCssHeight };
            canvas.width = newCssWidth * dpr;
            canvas.height = newCssHeight * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // Resizing clears the canvas; repaint so static grain survives.
            if (hasPattern) drawGrain();
        };

        const updatePattern = () => {
            for (let i = 0; i < patternPixelDataLength; i += 4) {
                const value = Math.random() * 255 * intensity;
                patternData.data[i] = value;
                patternData.data[i + 1] = value;
                patternData.data[i + 2] = value;
                patternData.data[i + 3] = patternAlpha;
            }
            patternCtx.putImageData(patternData, 0, 0);
            hasPattern = true;
        };

        const drawGrain = () => {
            const { width: cssWidth, height: cssHeight } = canvasCssSizeRef.current;
            if (cssWidth === 0 || cssHeight === 0) return;

            ctx.clearRect(0, 0, cssWidth, cssHeight);
            ctx.save();

            const safePatternScaleX = Math.max(0.001, patternScaleX);
            const safePatternScaleY = Math.max(0.001, patternScaleY);
            ctx.scale(safePatternScaleX, safePatternScaleY);

            const fillPattern = ctx.createPattern(patternCanvas, "repeat");
            if (fillPattern) {
                ctx.fillStyle = fillPattern;
                ctx.fillRect(
                    0,
                    0,
                    cssWidth / safePatternScaleX,
                    cssHeight / safePatternScaleY,
                );
            }

            ctx.restore();
        };

        let animationFrameId = 0;
        let isVisible = true;
        const loop = () => {
            animationFrameId = 0;
            if (!isVisible) return;
            if (
                canvasCssSizeRef.current.width > 0 &&
                canvasCssSizeRef.current.height > 0
            ) {
                if (frame % patternRefreshInterval === 0) {
                    updatePattern();
                    drawGrain();
                }
            }
            frame++;
            animationFrameId = window.requestAnimationFrame(loop);
        };

        window.addEventListener("resize", resize);
        resize();

        // Animated grain only runs while the canvas is on screen; a long
        // thread can mount dozens of these and each loop ticks at 60 Hz.
        let observer: IntersectionObserver | null = null;
        if (patternRefreshInterval > 0) {
            if (typeof IntersectionObserver !== "undefined") {
                observer = new IntersectionObserver((entries) => {
                    isVisible = entries.some((entry) => entry.isIntersecting);
                    if (isVisible && !animationFrameId) {
                        animationFrameId = window.requestAnimationFrame(loop);
                    }
                });
                observer.observe(canvas);
            }
            loop();
        } else {
            updatePattern();
            drawGrain();
        }

        return () => {
            window.removeEventListener("resize", resize);
            observer?.disconnect();
            if (animationFrameId) {
                window.cancelAnimationFrame(animationFrameId);
            }
        };
    }, [
        patternSize,
        patternScaleX,
        patternScaleY,
        patternRefreshInterval,
        patternAlpha,
        intensity,
    ]);

    return (
        <canvas
            className="absolute inset-0 w-full h-full pointer-events-none"
            ref={grainRef}
        />
    );
}

interface GradientColor {
    color: string;
    stop: string;
}

type GradientOrigin =
    | "bottom-middle"
    | "bottom-left"
    | "bottom-right"
    | "top-middle"
    | "top-left"
    | "top-right"
    | "left-middle"
    | "right-middle"
    | "center";

interface GradientBackgroundProps {
    gradientType?: "radial-gradient" | "linear-gradient" | "conic-gradient";
    gradientSize?: string;
    gradientOrigin?: GradientOrigin;
    colors?: GradientColor[];
    enableNoise?: boolean;
    noisePatternSize?: number;
    noisePatternScaleX?: number;
    noisePatternScaleY?: number;
    noisePatternRefreshInterval?: number;
    noisePatternAlpha?: number;
    noiseIntensity?: number;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
    customGradient?: string | null;
}

function GradientBackground({
    gradientType = "radial-gradient",
    gradientSize = "125% 125%",
    gradientOrigin = "bottom-middle",
    colors = [
        { color: "rgba(245,87,2,1)", stop: "10.5%" },
        { color: "rgba(245,120,2,1)", stop: "16%" },
        { color: "rgba(245,140,2,1)", stop: "17.5%" },
        { color: "rgba(245,170,100,1)", stop: "25%" },
        { color: "rgba(238,174,202,1)", stop: "40%" },
        { color: "rgba(202,179,214,1)", stop: "65%" },
        { color: "rgba(148,201,233,1)", stop: "100%" },
    ],
    enableNoise = true,
    noisePatternSize = 100,
    noisePatternScaleX = 1,
    noisePatternScaleY = 1,
    noisePatternRefreshInterval = 1,
    noisePatternAlpha = 50,
    noiseIntensity = 1,
    className = "",
    style = {},
    children,
    customGradient = null,
}: GradientBackgroundProps) {
    const generateGradient = () => {
        if (customGradient) return customGradient;

        const getGradientPosition = (origin: GradientOrigin) => {
            const positions: Record<GradientOrigin, string> = {
                "bottom-middle": "50% 101%",
                "bottom-left": "0% 101%",
                "bottom-right": "100% 101%",
                "top-middle": "50% -1%",
                "top-left": "0% -1%",
                "top-right": "100% -1%",
                "left-middle": "-1% 50%",
                "right-middle": "101% 50%",
                center: "50% 50%",
            };
            return positions[origin] || positions["bottom-middle"];
        };

        const position = getGradientPosition(gradientOrigin);
        const colorStops = colors
            .map(({ color, stop }) => `${color} ${stop}`)
            .join(",");

        if (gradientType === "radial-gradient") {
            return `radial-gradient(${gradientSize} at ${position},${colorStops})`;
        } else if (gradientType === "linear-gradient") {
            const angleMap: Record<GradientOrigin, string> = {
                "bottom-middle": "0deg",
                "bottom-left": "45deg",
                "bottom-right": "315deg",
                "top-middle": "180deg",
                "top-left": "135deg",
                "top-right": "225deg",
                "left-middle": "90deg",
                "right-middle": "270deg",
                center: "0deg",
            };
            const angle = angleMap[gradientOrigin] || angleMap["bottom-middle"];
            return `linear-gradient(${angle},${colorStops})`;
        } else if (gradientType === "conic-gradient") {
            return `conic-gradient(from 0deg at ${position},${colorStops})`;
        }

        return `${gradientType}(${colorStops})`;
    };

    const gradientStyle: React.CSSProperties = {
        background: generateGradient(),
        ...style,
    };

    return (
        <div
            className={`absolute inset-0 w-full h-full ${className}`}
            style={gradientStyle}
        >
            {enableNoise && (
                <Noise
                    patternSize={noisePatternSize}
                    patternScaleX={noisePatternScaleX}
                    patternScaleY={noisePatternScaleY}
                    patternRefreshInterval={noisePatternRefreshInterval}
                    patternAlpha={noisePatternAlpha}
                    intensity={noiseIntensity}
                />
            )}
            {children}
        </div>
    );
}

export { GradientBackground };
export type { GradientBackgroundProps, GradientColor, GradientOrigin };
