"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Coins,
  Cpu,
  Radio,
} from "lucide-react";
import type { UsageSnapshot } from "@/lib/usage";
import { dollars, number, useLocale } from "./Locale";
import {
  Card,
  EmptyState,
  PageTitle,
  Select,
  StatusPill,
  buttonClass,
} from "./ui";
export function Dashboard({ initial }: { initial: UsageSnapshot }) {
  const { t, locale } = useLocale();
  const [data, setData] = useState(initial);
  const [live, setLive] = useState(false);
  const [projectId, setProjectId] = useState("");
  useEffect(() => {
    setLive(false);
    const events = new EventSource(
      `/api/usage/events?project=${encodeURIComponent(projectId)}`,
    );
    events.addEventListener("usage", (event) => {
      setData(JSON.parse((event as MessageEvent).data));
      setLive(true);
    });
    events.onerror = () => setLive(false);
    return () => events.close();
  }, [projectId]);
  const max = Math.max(1, ...data.daily.map((day) => day.input + day.output));
  const cards = [
    {
      label: t("Tokens totales", "Total tokens"),
      value: number(data.totals.tokens, locale),
      note: projectId
        ? t("Proyecto seleccionado", "Selected project")
        : t("Todas las ejecuciones", "All runs"),
      icon: Cpu,
    },
    {
      label: t("Tokens de entrada", "Input tokens"),
      value: number(data.totals.input, locale),
      note: t("Prompts y contexto", "Prompts and context"),
      icon: ArrowDownLeft,
    },
    {
      label: t("Tokens de salida", "Output tokens"),
      value: number(data.totals.output, locale),
      note: t("Respuestas del modelo", "Model responses"),
      icon: ArrowUpRight,
    },
    {
      label: t("Costo estimado", "Estimated cost"),
      value:
        data.totals.unpriced > 0 && data.totals.cost === 0
          ? "—"
          : dollars(data.totals.cost, locale),
      note: data.totals.unpriced
        ? t(
            `${number(data.totals.unpriced, locale)} tokens sin tarifa`,
            `${number(data.totals.unpriced, locale)} unpriced tokens`,
          )
        : t("USD · precios por ejecución", "USD · per-run pricing"),
      icon: Coins,
    },
  ];
  return (
    <>
      <PageTitle
        title={t("Consumo en vivo", "Live usage")}
        actions={
          <span className={`live-indicator ${live ? "connected" : ""}`}>
            <Radio size={15} />
            {live ? t("En vivo", "Live") : t("Reconectando…", "Reconnecting…")}
          </span>
        }
      >
        {t(
          "Métricas reales de tus ejecuciones, actualizadas al finalizar cada llamada al modelo.",
          "Real metrics from your runs, updated after each model call completes.",
        )}
      </PageTitle>
      <div className="usage-toolbar">
        <label htmlFor="usage-project">
          {t("Ver consumo de", "Show usage for")}
        </label>
        <Select
          id="usage-project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">{t("Todos los proyectos", "All projects")}</option>
          {data.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
        <span>
          {t("Actualizado", "Updated")}{" "}
          <time dateTime={data.timestamp} suppressHydrationWarning>
            {new Date(data.timestamp).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        </span>
      </div>
      <div className="metrics-grid" aria-busy={data.projectId !== projectId}>
        {cards.map(({ label, value, note, icon: Icon }) => (
          <Card key={label} className="metric-card">
            <div>
              <span>{label}</span>
              <Icon size={17} />
            </div>
            <strong>{value}</strong>
            <small>{note}</small>
          </Card>
        ))}
      </div>
      <div className="dashboard-grid">
        <Card className="usage-chart">
          <div className="section-heading">
            <div>
              <h2>{t("Actividad de tokens", "Token activity")}</h2>
              <p>{t("Últimos 14 días · UTC", "Last 14 days · UTC")}</p>
            </div>
            <div className="chart-legend">
              <span>
                <i />
                {t("Entrada", "Input")}
              </span>
              <span>
                <i />
                {t("Salida", "Output")}
              </span>
            </div>
          </div>
          <div className="chart-container">
            <div className="chart-axis">
              <span>{number(max, locale)}</span>
              <span>{number(Math.round(max / 2), locale)}</span>
              <span>0</span>
            </div>
            <div
              className="bar-chart"
              role="img"
              aria-label={t(
                "Tokens por día. Los valores están disponibles en cada barra.",
                "Daily tokens. Values are available on each bar.",
              )}
            >
              {data.daily.map((day, index) => (
                <div
                  key={day.date}
                  className="bar-column"
                  tabIndex={0}
                  aria-label={`${day.date}: ${number(day.input, locale)} ${t("entrada", "input")}, ${number(day.output, locale)} ${t("salida", "output")}`}
                >
                  <div className="bar-tooltip">
                    {day.date}
                    <br />
                    {number(day.input + day.output, locale)} tokens
                  </div>
                  <div className="bar-stack">
                    <span
                      className="bar-output"
                      style={{ height: `${(day.output / max) * 100}%` }}
                    />
                    <span
                      className="bar-input"
                      style={{ height: `${(day.input / max) * 100}%` }}
                    />
                  </div>
                  <small>
                    {index % 2 === 0 ? day.date.slice(5).replace("-", "/") : ""}
                  </small>
                </div>
              ))}
            </div>
            {data.daily.every((day) => day.input + day.output === 0) && (
              <div className="chart-empty">
                <Activity size={23} />
                <strong>
                  {t(
                    "Sin actividad en este período",
                    "No activity in this period",
                  )}
                </strong>
                <span>
                  {t(
                    "El gráfico muestra las llamadas de los últimos 14 días.",
                    "The chart shows calls from the last 14 days.",
                  )}
                </span>
              </div>
            )}
          </div>
        </Card>
        <Card className="workspace-health">
          <div className="section-heading">
            <h2>{t("Tu workspace", "Your workspace")}</h2>
            <span className="online-dot" />
          </div>
          <div>
            <span>{t("Proyectos", "Projects")}</span>
            <strong>{data.projects.length}</strong>
          </div>
          <div>
            <span>{t("Ejecuciones activas", "Active runs")}</span>
            <strong>{data.active}</strong>
          </div>
          <div>
            <span>{t("Modelos guardados", "Saved models")}</span>
            <strong>{data.models.length}</strong>
          </div>
          <div>
            <span>Worker</span>
            <span
              className={`status ${data.workerAlive ? "status-succeeded" : "status-queued"}`}
            >
              <span />
              {data.workerAlive
                ? t("Activo", "Online")
                : t("Inactivo", "Offline")}
            </span>
          </div>
          <p className="field-hint">
            {t(
              "Los tokens provienen del proveedor. Los costos son estimaciones; el consumo sin tarifa se informa por separado.",
              "Token counts come from the provider. Costs are estimates; unpriced usage is reported separately.",
            )}
          </p>
          <Link href="/settings" className="text-link">
            {t("Administrar modelos", "Manage models")}
            <ArrowRight size={14} />
          </Link>
        </Card>
      </div>
      <Card>
        <div className="section-heading">
          <div>
            <h2>{t("Últimas ejecuciones", "Recent runs")}</h2>
            <p>
              {t(
                "Consumo, costo y estado en un solo lugar.",
                "Usage, cost, and status in one place.",
              )}
            </p>
          </div>
          <Link href="/projects" className="text-link">
            {t("Ver proyectos", "View projects")}
            <ArrowRight size={14} />
          </Link>
        </div>
        {data.jobs.length === 0 ? (
          <EmptyState
            icon={<Activity size={26} />}
            title={t("Todavía no hay consumo", "No usage yet")}
            action={
              <Link href="/projects/new" className={buttonClass("ghost")}>
                {t("Crear proyecto", "Create project")}
              </Link>
            }
          >
            {t(
              "Las ejecuciones aparecerán acá con sus métricas reales. No se muestran datos simulados.",
              "Runs will appear here with their real metrics. No simulated data is shown.",
            )}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Ejecución", "Run")}</th>
                  <th>{t("Estado", "Status")}</th>
                  <th>{t("Entrada", "Input")}</th>
                  <th>{t("Salida", "Output")}</th>
                  <th>{t("Costo estimado", "Estimated cost")}</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={`/jobs/${job.id}`} className="table-link">
                        {job.title}
                        <ArrowUpRight size={13} />
                      </Link>
                      <small>
                        {data.projects.find(
                          (project) => project.id === job.projectId,
                        )?.name ?? "—"}
                      </small>
                    </td>
                    <td>
                      <StatusPill status={job.status} />
                    </td>
                    <td>{number(job.usage.inputTokens, locale)}</td>
                    <td>{number(job.usage.outputTokens, locale)}</td>
                    <td>
                      {job.usage.estimatedCostUsd !== undefined &&
                      (job.usage.unpricedTokens ?? 0) < job.usage.totalTokens
                        ? dollars(job.usage.estimatedCostUsd, locale)
                        : "—"}
                      {Boolean(job.usage.unpricedTokens) && " *"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
