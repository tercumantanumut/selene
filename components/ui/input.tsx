import * as React from "react"
import { motion, type HTMLMotionProps } from "framer-motion"
import { cn } from "@/lib/utils"

// ============================================================================
// BASE INPUT
// ============================================================================

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-border/70 bg-muted/30 px-3 py-1 text-base shadow-inner",
          "transition-all duration-200 ease-out",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:bg-muted/50",
          "hover:bg-muted/40",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

// ============================================================================
// ANIMATED INPUT WITH FOCUS EFFECTS
// ============================================================================

interface AnimatedInputProps
  extends Omit<HTMLMotionProps<"input">, "ref"> {
  type?: string;
}

const AnimatedInput = React.forwardRef<HTMLInputElement, AnimatedInputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <motion.input
        ref={ref}
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md bg-muted/30 px-3 py-1 text-base",
          "transition-colors",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:bg-muted/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "md:text-sm",
          className
        )}
        whileFocus={{ scale: 1.01 }}
        transition={{
          type: "spring" as const,
          stiffness: 400,
          damping: 30,
        }}
        {...props}
      />
    )
  }
)
AnimatedInput.displayName = "AnimatedInput"

export { Input }
