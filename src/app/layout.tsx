import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppearanceSync } from "@/components/appearance-sync";
import { appearanceAttributes, colorSchemeFor, themeColorFor } from "@/lib/appearance";
import { appearanceForRequest } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import "./globals.css";

const sourceSerif = localFont({
  // Geist's x-height over Source Serif 4's (53.0 and 49.2 per 100px). next/font only takes literals here.
  declarations: [{ prop: "size-adjust", value: "107%" }],
  src: [
    { path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2", style: "normal" },
    { path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2", style: "italic" },
  ],
  weight: "200 900",
  display: "swap",
  preload: false,
  variable: "--font-source-serif",
});

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "orbit",
};

export async function generateViewport(): Promise<Viewport> {
  const { theme } = await appearanceForRequest();
  return { themeColor: themeColorFor(theme), colorScheme: colorSchemeFor(theme) };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const appearance = await appearanceForRequest();
  return (
    <html
      lang="en"
      {...appearanceAttributes(appearance)}
      className={cn("h-full", GeistSans.variable, GeistMono.variable, sourceSerif.variable)}
    >
      <body className="h-full">
        <AppearanceSync appearance={appearance} />
        {children}
      </body>
    </html>
  );
}
