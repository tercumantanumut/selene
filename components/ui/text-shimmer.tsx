'use client';
import React, { useMemo, type JSX } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

// motion.create returns a new component type per call; creating it during
// render remounted the shimmer element on every parent re-render.
const createMotionComponent = (component: React.ElementType) =>
  motion.create(component as keyof JSX.IntrinsicElements);
const motionComponents = new Map<React.ElementType, ReturnType<typeof createMotionComponent>>();

function getMotionComponent(component: React.ElementType) {
  let motionComponent = motionComponents.get(component);
  if (!motionComponent) {
    motionComponent = createMotionComponent(component);
    motionComponents.set(component, motionComponent);
  }
  return motionComponent;
}

interface TextShimmerProps {
  children: string;
  as?: React.ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

export function TextShimmer({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) {
  const MotionComponent = getMotionComponent(Component);

  const dynamicSpread = useMemo(() => {
    return children.length * spread;
  }, [children, spread]);

  return (
    <MotionComponent
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text',
        'text-transparent [--base-color:#a1a1aa] [--base-gradient-color:#000]',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        'dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff] dark:[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]',
        className
      )}
      initial={{ backgroundPosition: '100% center' }}
      animate={{ backgroundPosition: '0% center' }}
      transition={{
        repeat: Infinity,
        duration,
        ease: 'linear',
      }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
        } as React.CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
}
