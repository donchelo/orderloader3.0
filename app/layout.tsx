import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ChangelogPill } from "@/components/ChangelogPill";

const redHatDisplay = localFont({
  src: [
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-Light.ttf",       weight: "300", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-LightItalic.ttf", weight: "300", style: "italic" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-Regular.ttf",     weight: "400", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-Italic.ttf",      weight: "400", style: "italic" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-Medium.ttf",      weight: "500", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-MediumItalic.ttf",weight: "500", style: "italic" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-SemiBold.ttf",    weight: "600", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-SemiBoldItalic.ttf", weight: "600", style: "italic" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-Bold.ttf",        weight: "700", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-BoldItalic.ttf",  weight: "700", style: "italic" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-ExtraBold.ttf",   weight: "800", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-ExtraBoldItalic.ttf", weight: "800", style: "italic" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-Black.ttf",       weight: "900", style: "normal" },
    { path: "../public/brand/fonts/Red_Hat_Display/RedHatDisplay-BlackItalic.ttf", weight: "900", style: "italic" },
  ],
  variable: "--font-red-hat",
  display: "swap",
});

const nectoMono = localFont({
  src: "../public/brand/fonts/CLT Necto Mono/NectoMono-Regular.otf",
  variable: "--font-necto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OrderLoader — SAP B1 Order Pipeline",
  description: "Automatización de pedidos: Email → SAP B1",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${redHatDisplay.variable} ${nectoMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <ChangelogPill />
      </body>
    </html>
  );
}
