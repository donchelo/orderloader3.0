import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { HTMLAttributes } from "react";

const card = cva(
  "rounded-[1rem] overflow-hidden transition-shadow duration-200",
  {
    variants: {
      variant: {
        // Mint cream base — página 9 izquierda
        light:
          "bg-mint-cream border border-erie-black/10 shadow-sm hover:shadow-md",
        // Erie black — página 9 centro (dark card)
        dark:
          "bg-erie-black text-white",
        // Moderate blue accent
        blue:
          "bg-moderate-blue/10 border border-moderate-blue/30",
        // White — elevado
        elevated:
          "bg-white shadow-md hover:shadow-lg",
      },
      padding: {
        none: "",
        sm:   "p-4",
        md:   "p-6",
        lg:   "p-8",
      },
    },
    defaultVariants: {
      variant: "light",
      padding: "md",
    },
  }
);

export type CardProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof card>;

export function Card({ className, variant, padding, ...props }: CardProps) {
  return (
    <div
      className={twMerge(clsx(card({ variant, padding }), className))}
      {...props}
    />
  );
}

/* ─── Sub-components ──────────────────────────────────────────────────── */

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={twMerge("mb-4 flex flex-col gap-1", className ?? "")}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={twMerge("flex-1", className ?? "")} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={twMerge("mt-4 flex items-center gap-3", className ?? "")}
      {...props}
    />
  );
}
