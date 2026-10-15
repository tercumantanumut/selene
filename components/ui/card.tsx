import * as React from "react"
import { motion, type HTMLMotionProps } from "framer-motion"
import { cn } from "@/lib/utils"


// ============================================================================
// BASE CARD
// ============================================================================

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border border-border/70 bg-card/95 text-card-foreground shadow-surface transition-shadow duration-200",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

// ============================================================================
// ANIMATED CARD SPAN - For use inside <p> tags (avoids hydration errors)
// Uses <span> with display:block instead of <div> to maintain valid HTML nesting
// ============================================================================

interface AnimatedCardSpanProps
  extends Omit<HTMLMotionProps<"span">, "ref"> {
  hoverLift?: boolean;
  hoverGlow?: boolean;
}

const AnimatedCardSpan = React.forwardRef<HTMLSpanElement, AnimatedCardSpanProps>(
  ({ className, hoverLift = true, hoverGlow = false, children, ...props }, ref) => (
    <motion.span
      ref={ref}
      className={cn(
        "block rounded-lg border border-border/70 bg-card/95 text-card-foreground shadow-surface",
        hoverGlow && "hover:shadow-lg hover:shadow-primary/10",
        className
      )}
      whileHover={hoverLift ? { y: -4, scale: 1.01 } : undefined}
      whileTap={{ scale: 0.99 }}
      transition={{
        type: "spring" as const,
        stiffness: 400,
        damping: 25,
      }}
      {...props}
    >
      {children}
    </motion.span>
  )
)
AnimatedCardSpan.displayName = "AnimatedCardSpan"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1 p-5", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-5 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-5 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, AnimatedCardSpan, CardHeader, CardTitle, CardContent }
