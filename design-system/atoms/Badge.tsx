"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";
import type { HTMLAttributes } from "react";

const badge = cva(
  "inline-flex items-center rounded-[9999px] font-semibold tracking-[0.05em] select-none whitespace-nowrap",
  {
    variants: {
      variant: {
        outline: "border border-erie-black text-erie-black bg-transparent",
        solid:   "bg-erie-black text-white",
        accent:  "bg-hot-orange text-white",
        muted:   "bg-cadet-gray/20 text-cadet-gray",
        blue:    "bg-moderate-blue/15 text-moderate-blue",
        success: "bg-moderate-blue text-white",
        danger:  "bg-hot-orange text-white",
      },
      size: {
        sm: "h-5  px-2.5 text-[10px]",
        md: "h-6  px-3   text-xs",
        lg: "h-8  px-4   text-sm",
      },
    },
    defaultVariants: {
      variant: "outline",
      size:    "md",
    },
  }
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badge>;

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <span className={cn(badge({ variant, size }), className)} {...props} />
  );
}
