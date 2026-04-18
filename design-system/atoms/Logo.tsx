import Image from "next/image";
import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

type LogoColor   = "negro" | "naranja" | "azul" | "crema" | "gris";
type LogoVersion = "v1" | "v2" | "v3" | "isotipo";

const logoMap: Record<LogoVersion, Record<LogoColor, string>> = {
  v1: {
    negro:   "/brand/logos/Export/Logo V1 - Negro.png",
    naranja: "/brand/logos/Export/Logo V1 - Naranja.png",
    azul:    "/brand/logos/Export/Logo V1 - Azul.png",
    crema:   "/brand/logos/Export/Logo V1 - Crema.png",
    gris:    "/brand/logos/Export/Logo V1 - Gris.png",
  },
  v2: {
    negro:   "/brand/logos/Export/Logo V2 - Negro.png",
    naranja: "/brand/logos/Export/Logo V2 - Naranja.png",
    azul:    "/brand/logos/Export/Logo V2 - Azul.png",
    crema:   "/brand/logos/Export/Logo V2 - Crema .png",
    gris:    "/brand/logos/Export/Logo V2 - Gris.png",
  },
  v3: {
    negro:   "/brand/logos/Export/Logo V3 - Negro.png",
    naranja: "/brand/logos/Export/Logo V3 - Naranja.png",
    azul:    "/brand/logos/Export/Logo V3 - Azul.png",
    crema:   "/brand/logos/Export/Logo V3 - Crema.png",
    gris:    "/brand/logos/Export/Logo V3 - Gris.png",
  },
  isotipo: {
    negro:   "/brand/logos/Export/Isotipo Negro.png",
    naranja: "/brand/logos/Export/Isotipo Naranja.png",
    azul:    "/brand/logos/Export/Isotipo Azul.png",
    crema:   "/brand/logos/Export/Isotipo Crema.png",
    gris:    "/brand/logos/Export/Isotipo Gris.png",
  },
};

export type LogoProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  version?: LogoVersion;
  color?:   LogoColor;
  height?:  number;
  alt?:     string;
};

export function Logo({
  version = "v1",
  color   = "negro",
  height  = 32,
  alt     = "Ai4U",
  className,
  ...props
}: LogoProps) {
  const src = logoMap[version][color];

  return (
    <span
      className={clsx("inline-flex items-center shrink-0", className)}
      {...props}
    >
      <Image
        src={src}
        alt={alt}
        height={height}
        width={0}
        style={{ height, width: "auto" }}
        priority
        unoptimized
      />
    </span>
  );
}
