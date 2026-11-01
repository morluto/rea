"use client";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Code2,
  Cpu,
  Fingerprint,
  FolderOpen,
  GitBranch,
  Layers3,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useLocale } from "@/components/Locale";
import { buttonClass } from "@/components/ui";
export default function HomePage() {
  const { t } = useLocale();
  const steps = [
    [
      t("Entendé", "Understand"),
      t(
        "Analizá la app y sus comportamientos con evidencia real.",
        "Analyze the app and its behavior with real evidence.",
      ),
      Fingerprint,
    ],
    [
      t("Diseñá", "Design"),
      t(
        "Revisá la especificación antes de generar código.",
        "Review the specification before generating code.",
      ),
      Layers3,
    ],
    [
      t("Construí", "Build"),
      t(
        "Elegí tu stack y generá una versión mejorada.",
        "Choose your stack and generate an improved version.",
      ),
      Code2,
    ],
    [
      t("Verificá", "Verify"),
      t(
        "Compará resultados, pruebas y diferencias.",
        "Compare results, tests, and differences.",
      ),
      CheckCheck,
    ],
  ] as const;
  return (
    <div className="home-page">
      <section className="hero">
        <div className="hero-copy">
          <h1>
            {t("Entendé cómo funciona.", "Understand how it works.")}
            <br />
            {t("Hacelo realidad.", "Make it real.")}
          </h1>
          <p>
            {t(
              "Transformá aplicaciones en un nuevo punto de partida. Analizá, reconstruí y mejorá con IA, tus propios modelos y el código siempre en tus manos.",
              "Turn applications into a new starting point. Analyze, rebuild, and improve with AI, your own models, and code that stays in your hands.",
            )}
          </p>
          <div className="hero-actions">
            <Link href="/projects/new" className={buttonClass("primary")}>
              {t("Crear mi primer proyecto", "Create my first project")}
              <ArrowRight size={17} />
            </Link>
            <a href="#how-it-works" className="text-link">
              {t("Cómo funciona", "How it works")}
              <ArrowUpRight size={15} />
            </a>
          </div>
        </div>
        <div
          className="hero-visual"
          aria-label={t(
            "Resumen del flujo de Reall",
            "Overview of the Reall workflow",
          )}
        >
          <div className="process-header">
            <span>REALL / WORKFLOW</span>
            <span>{t("Tu proyecto", "Your project")}</span>
          </div>
          <div className="process-steps">
            {steps.map(([title, description], index) => (
              <div className="process-step" key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </div>
                <ArrowRight size={16} aria-hidden="true" />
              </div>
            ))}
          </div>
          <div className="process-output">
            <Code2 size={17} aria-hidden="true" />
            <code>project/output/</code>
            <span>{t("Tu código", "Your code")}</span>
          </div>
        </div>
      </section>
      <section className="provider-strip">
        <p>{t("Tu modelo", "Your model")}</p>
        <div>
          <span>
            <span className="provider-logo">◉</span>OpenAI
          </span>
          <span className="anthropic-word">Anthropic</span>
          <span>
            <Sparkles size={19} />
            Gemini
          </span>
          <span>
            <GitBranch size={18} />
            OpenRouter
          </span>
          <span>
            <Terminal size={18} />
            Ollama
          </span>
          <span className="custom-provider">
            + {t("tu proveedor", "your provider")}
          </span>
        </div>
      </section>
      <section id="how-it-works" className="how-section">
        <div className="section-heading">
          <div>
            <h2>
              {t(
                "De observar a crear. Sin perder el control.",
                "From observing to creating. Stay in control.",
              )}
            </h2>
          </div>
          <span className="section-note">
            {t("Vos decidís en cada paso.", "Your decision, at every step.")}
          </span>
        </div>
        <div className="steps-grid">
          {steps.map(([title, description, Icon], i) => (
            <article key={title} className="step-card">
              <div className="step-top">
                <span className="step-icon">
                  <Icon size={20} />
                </span>
                <span className="step-number">0{i + 1}</span>
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="features-row">
        <div>
          <FolderOpen size={21} />
          <h3>{t("El código, donde quieras", "Code, wherever you want")}</h3>
          <p>
            {t(
              "Elegí la carpeta de cada proyecto. Explorá los archivos y descargá todo en un ZIP.",
              "Choose a folder for each project. Browse the files and download everything as a ZIP.",
            )}
          </p>
        </div>
        <div>
          <Cpu size={21} />
          <h3>{t("Cada token cuenta", "Every token counts")}</h3>
          <p>
            {t(
              "Seguí el consumo y costo estimado en vivo, con presupuestos por ejecución.",
              "Track live usage and estimated cost, with per-run budgets.",
            )}
          </p>
        </div>
        <div>
          <ShieldCheck size={21} />
          <h3>{t("Tus claves, bajo tu control", "Your keys, your control")}</h3>
          <p>
            {t(
              "Claves cifradas en tu máquina. Se usan únicamente con el proveedor elegido.",
              "Encrypted keys on your machine. Used only with your chosen provider.",
            )}
          </p>
        </div>
      </section>
      <section className="home-cta">
        <div>
          <h2>
            {t(
              "Configurá tus modelos y empezá.",
              "Set up your models and get started.",
            )}
          </h2>
        </div>
        <Link href="/settings" className={buttonClass("ghost")}>
          {t("Configurar mis modelos", "Set up my models")}
          <ArrowRight size={16} />
        </Link>
      </section>
    </div>
  );
}
