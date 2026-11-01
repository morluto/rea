"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  FolderKanban,
  Gauge,
  Home,
  Settings2,
  ChevronRight,
  Menu,
  X,
  Plus,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useLocale } from "./Locale";
export function Shell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useLocale();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const nav = [
    { href: "/", text: t("Inicio", "Home"), icon: Home },
    { href: "/projects", text: t("Proyectos", "Projects"), icon: FolderKanban },
    { href: "/dashboard", text: t("Consumo", "Usage"), icon: Gauge },
    {
      href: "/settings",
      text: t("Configuración", "Settings"),
      icon: Settings2,
    },
  ];
  const active =
    nav.find((item) =>
      item.href === "/" ? path === "/" : path.startsWith(item.href),
    ) ?? nav[1]!;
  return (
    <div className="app-shell">
      {open && (
        <button
          className="nav-backdrop"
          aria-label={t("Cerrar menú", "Close menu")}
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-symbol">
            <span />
            <span />
            <span />
          </span>
          Reall<span className="brand-dot">.</span>
        </Link>
        <Link
          href="/projects/new"
          className="sidebar-create"
          onClick={() => setOpen(false)}
        >
          <Plus size={17} />
          {t("Crear proyecto", "Create project")}
        </Link>
        <nav aria-label={t("Navegación principal", "Main navigation")}>
          {nav.map(({ href, text, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              aria-current={active.href === href ? "page" : undefined}
              className={`nav-item ${active.href === href ? "active" : ""}`}
            >
              <Icon size={18} />
              <span>{text}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            href="https://artesia.ar"
            target="_blank"
            rel="noreferrer"
            className="artesia"
          >
            {t("Construida por", "Built by")}
            <strong>
              Artesia <span>by Conra</span>
            </strong>
            <ArrowUpRight size={15} />
          </a>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu icon-button"
              onClick={() => setOpen(!open)}
              aria-label={t("Abrir menú", "Open menu")}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span className="desktop-mark">Reall</span>
            <ChevronRight size={13} />
            <span>{active.text}</span>
          </div>
          <div className="topbar-actions">
            <span className="local-badge">
              <span className="online-dot" />
              {t("Entorno local", "Local environment")}
            </span>
            <div
              className="language-switch"
              aria-label={t("Idioma", "Language")}
            >
              {(["es", "en"] as const).map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLocale(lang)}
                  aria-pressed={locale === lang}
                >
                  {lang.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {children}
        </main>
        <footer className="main-footer">
          <span>
            Reall ·{" "}
            {t(
              "De la observación a la creación.",
              "From observation to creation.",
            )}
          </span>
          <a href="https://artesia.ar" target="_blank" rel="noreferrer">
            {t("Construida por Artesia by Conra", "Built by Artesia by Conra")}{" "}
            <ArrowUpRight size={12} />
          </a>
        </footer>
      </div>
    </div>
  );
}
