import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getStore, isAllowedHost } from "@/lib/server";
import { LocaleProvider } from "@/components/Locale";
import { Shell } from "@/components/Shell";
import "@fontsource-variable/inter";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Reall — Ideas into real code", template: "%s · Reall" },
  description:
    "Analizá, reconstruí y mejorá aplicaciones con tus propios modelos. Analyze, rebuild and improve applications with your own models.",
};
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (!isAllowedHost((await headers()).get("host"))) notFound();
  const saved = (await cookies()).get("reall-language")?.value;
  const locale =
    saved === "es" || saved === "en"
      ? saved
      : getStore().getSettings().language;
  return (
    <html lang={locale} data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">
          {locale === "es" ? "Ir al contenido" : "Skip to content"}
        </a>
        <LocaleProvider initial={locale}>
          <Shell>{children}</Shell>
        </LocaleProvider>
      </body>
    </html>
  );
}
