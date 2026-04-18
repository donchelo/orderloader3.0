/* Ai4U Design System — Design Tokens */

export const colors = {
  mintCream:    "#eaf4eb",  // base, claridad y minimalismo
  erieBlack:    "#171717",  // contraste elegante
  hotOrange:    "#ff6e00",  // energía y llamados a la acción
  moderateBlue: "#3daed1",  // futuro y tecnología
  cadetGray:    "#94989b",  // balance y neutralidad
  white:        "#ffffff",
} as const;

export const typography = {
  fontSans:  "var(--font-red-hat)",
  fontMono:  "var(--font-necto-mono)",
  tracking:  "0.05em",      // interletra 20 (brand spec)
  weights: {
    light:     300,
    regular:   400,
    medium:    500,
    semibold:  600,
    bold:      700,
    extrabold: 800,
    black:     900,
  },
  scale: {
    display: "clamp(2.5rem, 6vw, 4.5rem)",
    h1:      "clamp(2rem, 4vw, 3rem)",
    h2:      "clamp(1.5rem, 3vw, 2rem)",
    h3:      "1.25rem",
    body:    "1rem",
    sm:      "0.875rem",
    xs:      "0.75rem",
  },
} as const;

export const radius = {
  pill: "9999px",
  card: "1rem",
  sm:   "0.5rem",
} as const;

export const spacing = {
  xs:  "0.25rem",
  sm:  "0.5rem",
  md:  "1rem",
  lg:  "1.5rem",
  xl:  "2rem",
  "2xl": "3rem",
  "3xl": "4rem",
} as const;
