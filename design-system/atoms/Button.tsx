"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ButtonHTMLAttributes } from "react";

const button = cva(
  // base — pill shape, brand tracking, transition
  "inline-flex items-center justify-center gap-2 rounded-[9999px] font-semibold tracking-[0.05em] transition-all duration-200 cursor-pointer select-none whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        // Solid black — "verdaderamente"
        primary:
          "bg-erie-black text-white hover:bg-[#2a2a2a] focus-visible:ring-erie-black",
        // Outline — "importa →"
        secondary:
          "border-2 border-erie-black text-erie-black bg-transparent hover:bg-erie-black hover:text-white focus-visible:ring-erie-black",
        // Hot orange — CTAs energéticos
        accent:
          "bg-hot-orange text-white hover:brightness-110 focus-visible:ring-hot-orange",
        // Ghost / text
        ghost:
          "text-erie-black hover:bg-erie-black/8 focus-visible:ring-erie-black",
      },
      size: {
        sm:  "h-8  px-4  text-sm",
        md:  "h-11 px-6  text-base",
        lg:  "h-14 px-8  text-lg",
      },
    },
    defaultVariants: {
      variant: "primary",
      size:    "md",
    },
  }
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      className={twMerge(clsx(button({ variant, size }), className))}
      {...props}
    />
  );
}
