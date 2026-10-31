"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { JobStatus } from "@rea-studio/core/types";
export type Locale = "es" | "en";
const Context = createContext({
  locale: "es" as Locale,
  setLocale: (_: Locale) => {},
  t: (es: string, _en: string) => es,
});
export function LocaleProvider({
  initial,
  children,
}: {
  initial: Locale;
  children: ReactNode;
}) {
  const [locale, change] = useState(initial);
  const setLocale = (next: Locale) => {
    change(next);
    document.cookie = `reall-language=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = next;
  };
  return (
    <Context.Provider
      value={{ locale, setLocale, t: (es, en) => (locale === "es" ? es : en) }}
    >
      {children}
    </Context.Provider>
  );
}
export const useLocale = () => useContext(Context);
export function statusLabel(status: JobStatus, locale: Locale) {
  const values = {
    queued: ["En cola", "Queued"],
    running: ["En ejecución", "Running"],
    waiting_approval: ["Requiere revisión", "Needs review"],
    succeeded: ["Completado", "Completed"],
    failed: ["Falló", "Failed"],
    cancelled: ["Cancelado", "Cancelled"],
  };
  return values[status][locale === "es" ? 0 : 1];
}
export const number = (value: number, locale: Locale) =>
  new Intl.NumberFormat(locale === "es" ? "es-AR" : "en-US").format(value);
export const dollars = (value: number, locale: Locale) =>
  new Intl.NumberFormat(locale === "es" ? "es-AR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
