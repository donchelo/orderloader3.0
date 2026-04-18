import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { HTMLAttributes } from "react";

type Tag = "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div";

type TextVariant =
  | "display"   // Hero — Black, huge
  | "h1"        // Page title — Bold
  | "h2"        // Section title — SemiBold
  | "h3"        // Sub-section — SemiBold
  | "body"      // Body copy — Regular
  | "bodyBold"  // Emphasized body — SemiBold
  | "sm"        // Small — Regular
  | "xs"        // Caption — Light
  | "mono";     // Numbers / special chars — Necto Mono

const variantStyles: Record<TextVariant, string> = {
  display:  "font-black  text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05] tracking-[-0.01em]",
  h1:       "font-bold   text-[clamp(2rem,4vw,3rem)]     leading-[1.1]  tracking-[0.02em]",
  h2:       "font-semibold text-[clamp(1.5rem,3vw,2rem)] leading-[1.2]  tracking-[0.03em]",
  h3:       "font-semibold text-[1.25rem]                leading-[1.3]  tracking-[0.04em]",
  body:     "font-normal  text-[1rem]                    leading-[1.6]  tracking-[0.05em]",
  bodyBold: "font-semibold text-[1rem]                   leading-[1.6]  tracking-[0.05em]",
  sm:       "font-normal  text-[0.875rem]                leading-[1.5]  tracking-[0.04em]",
  xs:       "font-light   text-[0.75rem]                 leading-[1.4]  tracking-[0.06em] text-cadet-gray",
  mono:     "font-normal  text-[0.875rem]                leading-[1.4]  tracking-[0]      font-mono",
};

const defaultTag: Record<TextVariant, Tag> = {
  display:  "h1",
  h1:       "h1",
  h2:       "h2",
  h3:       "h3",
  body:     "p",
  bodyBold: "p",
  sm:       "p",
  xs:       "span",
  mono:     "span",
};

export type TextProps = HTMLAttributes<HTMLElement> & {
  variant?: TextVariant;
  as?: Tag;
};

export function Text({
  variant = "body",
  as,
  className,
  ...props
}: TextProps) {
  const Tag = as ?? defaultTag[variant];
  return (
    <Tag
      className={twMerge(clsx(variantStyles[variant], className))}
      {...props}
    />
  );
}
