"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { diffLines } from "diff";
import {
  Activity,
  ArrowLeft,
  ArrowUp,
  Check,
  Circle,
  Clock3,
  Code2,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitCompareArrows,
  Radio,
  RefreshCw,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-react";
import type {
  ApprovalRecord,
  JobRecord,
  StoredEvent,
  PhaseId,
} from "@rea-studio/core";
import { api, post } from "@/lib/client";
import { dollars, number, useLocale } from "./Locale";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageTitle,
  StatusPill,
  Textarea,
  buttonClass,
} from "./ui";
import { Markdown } from "./Markdown";
interface FileResult {
  type: "dir" | "file";
  path: string;
  entries?: { name: string; path: string; dir: boolean }[];
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
}
const terminal = (job: JobRecord) =>
  ["succeeded", "failed", "cancelled"].includes(job.status);
export function JobView({
  initial,
  initialApprovals,
  previousId,
}: {
  initial: JobRecord;
  initialApprovals: ApprovalRecord[];
  previousId?: string;
}) {
  const { t, locale } = useLocale();
  const [job, setJob] = useState(initial);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const newestEvents = events.slice().reverse();
  const [approvals, setApprovals] = useState(initialApprovals);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState("activity");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [file, setFile] = useState<FileResult>();
  const [folder, setFolder] = useState<FileResult>();
  const [report, setReport] = useState("");
  const [diff, setDiff] = useState<ReturnType<typeof diffLines>>();
  const lastSeq = useRef(0);
  const [phaseState, setPhaseState] = useState<
    Partial<Record<PhaseId, string>>
  >({});
  const phases = [
    ["analysis", t("Análisis", "Analysis")],
    ["spec", t("Especificación", "Specification")],
    ["build", t("Construcción", "Build")],
    ["verify", t("Verificación", "Verification")],
    ["report", t("Informe", "Report")],
  ] as const;
  async function refresh() {
    const result = await api<{ job: JobRecord; approvals: ApprovalRecord[] }>(
      `/api/jobs/${initial.id}`,
    );
    setJob(result.job);
    setApprovals(result.approvals);
  }
  useEffect(() => {
    const source = new EventSource(
      `/api/jobs/${initial.id}/events?after=${lastSeq.current}`,
    );
    source.onopen = () => setConnected(true);
    source.addEventListener("job", (event) => {
      const stored = JSON.parse((event as MessageEvent).data) as StoredEvent;
      if (stored.seq <= lastSeq.current) return;
      lastSeq.current = stored.seq;
      setEvents((old) => [...old, stored].slice(-500));
      const eventData = stored.event;
      if (eventData.type === "phase")
        setPhaseState((old) => ({
          ...old,
          [eventData.phase]: eventData.status,
        }));
      if (stored.event.type === "approval")
        void refresh().catch((cause) => setError(String(cause)));
    });
    source.addEventListener("status", () => {
      void refresh().catch((cause) => setError(String(cause)));
    });
    source.addEventListener("end", () => {
      setConnected(false);
      source.close();
      void refresh().catch((cause) => setError(String(cause)));
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [initial.id]);
  async function browse(path: string) {
    setBusy("files");
    setError("");
    setDiff(undefined);
    try {
      const result = await api<FileResult>(
        `/api/jobs/${job.id}/files?path=${encodeURIComponent(path)}`,
      );
      if (result.type === "dir") {
        setFolder(result);
        setFile(undefined);
      } else setFile(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  async function selectTab(next: string) {
    setTab(next);
    setError("");
    if (next === "files") void browse(".");
    if (next === "report") {
      setBusy("report");
      try {
        const result = await api<FileResult>(
          `/api/jobs/${job.id}/files?path=output/REPORT.md`,
        );
        setReport(result.content ?? "");
      } catch {
        setReport("");
      } finally {
        setBusy("");
      }
    }
  }
  async function decide(approval: ApprovalRecord, approved: boolean) {
    setBusy(approval.id);
    setError("");
    try {
      await post(`/api/jobs/${job.id}/approvals/${approval.id}`, {
        approved,
        note: notes[approval.id] ?? "",
      });
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <Link
        href={job.projectId ? `/projects/${job.projectId}` : "/projects"}
        className="back-link"
      >
        <ArrowLeft size={14} />
        {t("Volver al proyecto", "Back to project")}
      </Link>
      <PageTitle
        title={job.title}
        actions={
          <>
            <StatusPill status={job.status} />
            {!terminal(job) && (
              <Button
                variant="ghost"
                busy={busy === "cancel"}
                onClick={async () => {
                  if (
                    !confirm(
                      t(
                        "¿Cancelar esta ejecución? Se conservarán los archivos ya generados.",
                        "Cancel this run? Generated files will be kept.",
                      ),
                    )
                  )
                    return;
                  setBusy("cancel");
                  try {
                    await post(`/api/jobs/${job.id}/cancel`, {});
                    await refresh();
                  } catch (cause) {
                    setError(String(cause));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                <Square size={13} />
                {t("Cancelar", "Cancel")}
              </Button>
            )}
            <a
              href={`/api/jobs/${job.id}/download`}
              className={buttonClass("primary")}
            >
              <Download size={15} />
              {t("Descargar ZIP", "Download ZIP")}
            </a>
          </>
        }
      >
        {t(
          "Seguí el trabajo, revisá decisiones y explorá el código generado.",
          "Follow the work, review decisions, and explore generated code.",
        )}
      </PageTitle>
      <ErrorNotice message={error || job.error} />
      <div className="run-metrics">
        <div>
          <span>{t("Entrada", "Input")}</span>
          <strong>{number(job.usage.inputTokens, locale)}</strong>
        </div>
        <div>
          <span>{t("Salida", "Output")}</span>
          <strong>{number(job.usage.outputTokens, locale)}</strong>
        </div>
        <div>
          <span>{t("Costo estimado", "Estimated cost")}</span>
          <strong>
            {job.usage.estimatedCostUsd !== undefined &&
            (job.usage.unpricedTokens ?? 0) < job.usage.totalTokens
              ? dollars(job.usage.estimatedCostUsd, locale)
              : "—"}
          </strong>
          {Boolean(job.usage.unpricedTokens) && (
            <small>
              {t("Incluye tokens sin tarifa", "Includes unpriced tokens")}
            </small>
          )}
        </div>
        <div>
          <span>{t("Presupuesto de tokens", "Token budget")}</span>
          <strong>
            {number(job.usage.totalTokens, locale)}{" "}
            <small>
              /{" "}
              {job.spec.budget.maxTotalTokens
                ? number(job.spec.budget.maxTotalTokens, locale)
                : "∞"}
            </small>
          </strong>
          {job.spec.budget.maxTotalTokens && (
            <progress
              value={job.usage.totalTokens}
              max={job.spec.budget.maxTotalTokens}
            />
          )}
        </div>
      </div>
      <div className="run-phases">
        {phases.map(([id, label], index) => {
          const done = phaseState[id] === "finished";
          const active = !terminal(job) && phaseState[id] === "started";
          return (
            <div
              key={id}
              className={done ? "complete" : active ? "current" : ""}
            >
              <span>{done ? <Check size={14} /> : index + 1}</span>
              {label}
            </div>
          );
        })}
      </div>
      {approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => (
          <Card key={approval.id} className="approval-card">
            <div className="section-heading">
              <div>
                <h2>
                  {approval.kind === "spec"
                    ? t("Revisá la especificación", "Review the specification")
                    : approval.kind === "command"
                      ? t("Aprobar comando", "Approve command")
                      : t("Aprobar herramienta", "Approve tool")}
                </h2>
              </div>
              <ShieldCheck size={24} />
            </div>
            <details open={approval.kind === "spec"}>
              <summary>{approval.title}</summary>
              <div className="approval-detail">
                <Markdown source={approval.detail} />
              </div>
            </details>
            <label className="field">
              <span>
                {t(
                  "Comentarios o cambios solicitados",
                  "Feedback or requested changes",
                )}
              </span>
              <Textarea
                value={notes[approval.id] ?? ""}
                maxLength={4000}
                onChange={(event) =>
                  setNotes({ ...notes, [approval.id]: event.target.value })
                }
                placeholder={t(
                  "Indicá los cambios antes de continuar…",
                  "Describe changes before continuing…",
                )}
              />
            </label>
            <div className="form-actions">
              <Button
                variant="ghost"
                busy={busy === approval.id}
                onClick={() => void decide(approval, false)}
              >
                {approval.kind === "spec" && notes[approval.id]
                  ? t("Solicitar cambios", "Request changes")
                  : t("Rechazar", "Reject")}
              </Button>
              <Button
                busy={busy === approval.id}
                onClick={() => void decide(approval, true)}
              >
                <Check size={16} />
                {t("Aprobar y continuar", "Approve and continue")}
              </Button>
            </div>
          </Card>
        ))}
      <div className="tabs">
        <button
          aria-pressed={tab === "activity"}
          onClick={() => void selectTab("activity")}
        >
          <Activity size={16} />
          {t("Actividad", "Activity")}
        </button>
        <button
          aria-pressed={tab === "files"}
          onClick={() => void selectTab("files")}
        >
          <FolderOpen size={16} />
          {t("Archivos", "Files")}
        </button>
        <button
          aria-pressed={tab === "report"}
          onClick={() => void selectTab("report")}
        >
          <FileText size={16} />
          {t("Informe", "Report")}
        </button>
        <span className={`live-indicator ${connected ? "connected" : ""}`}>
          <Radio size={13} />
          {terminal(job)
            ? t("Finalizado", "Finished")
            : connected
              ? t("En vivo", "Live")
              : t("Reconectando…", "Reconnecting…")}
        </span>
      </div>
      {tab === "activity" && (
        <Card>
          {events.length === 0 ? (
            <EmptyState
              icon={<Clock3 size={27} />}
              title={t("Esperando actividad", "Waiting for activity")}
            >
              {t(
                "Los eventos aparecerán cuando el worker empiece la ejecución.",
                "Events will appear when the worker starts this run.",
              )}
            </EmptyState>
          ) : (
            <div className="timeline">
              {newestEvents.map(({ seq, ts, event }) => (
                <div key={seq} className={`timeline-item event-${event.type}`}>
                  <span className="timeline-dot">
                    {event.type === "tool-call" ? (
                      <Terminal size={13} />
                    ) : event.type === "file" ? (
                      <FileCode2 size={13} />
                    ) : event.type === "usage" ? (
                      <Activity size={13} />
                    ) : (
                      <Circle size={10} />
                    )}
                  </span>
                  <div>
                    <div className="timeline-heading">
                      <strong>
                        {event.type === "phase"
                          ? `${phases.find(([id]) => id === event.phase)?.[1]} · ${event.status === "finished" ? t("completada", "completed") : event.status === "failed" ? t("falló", "failed") : t("iniciada", "started")}`
                          : event.type === "tool-call" ||
                              event.type === "tool-result"
                            ? event.tool
                            : event.type === "usage"
                              ? t("Consumo actualizado", "Usage updated")
                              : event.type === "file"
                                ? event.path
                                : event.type === "done"
                                  ? t("Ejecución finalizada", "Run finished")
                                  : event.type === "approval"
                                    ? t("Aprobación", "Approval")
                                    : event.type === "text"
                                      ? t(
                                          "Respuesta del modelo",
                                          "Model response",
                                        )
                                      : t("Sistema", "System")}
                      </strong>
                      <time>{new Date(ts).toLocaleTimeString(locale)}</time>
                    </div>
                    {event.type === "text" ? (
                      <Markdown source={event.text} />
                    ) : event.type === "log" ? (
                      <p>{event.message}</p>
                    ) : event.type === "usage" ? (
                      <p>
                        {number(event.inputTokens, locale)}{" "}
                        {t("entrada", "input")} ·{" "}
                        {number(event.outputTokens, locale)}{" "}
                        {t("salida", "output")}
                        {event.estimatedCostUsd !== undefined &&
                          ` · ${dollars(event.estimatedCostUsd, locale)}`}{" "}
                        {event.model && <code>{event.model}</code>}
                      </p>
                    ) : event.type === "tool-call" ? (
                      <details>
                        <summary>
                          {t("Ver argumentos", "View arguments")}
                        </summary>
                        <pre>{event.input}</pre>
                      </details>
                    ) : event.type === "tool-result" ? (
                      <details>
                        <summary>
                          {event.ok
                            ? t("Resultado recibido", "Result received")
                            : t(
                                "La herramienta informó un error",
                                "Tool reported an error",
                              )}
                          {event.evidenceIds?.length
                            ? ` · ${event.evidenceIds.join(", ")}`
                            : ""}
                        </summary>
                        <pre>{event.preview}</pre>
                        {event.savedTo && (
                          <button
                            className="text-link"
                            onClick={() => {
                              setTab("files");
                              void browse(event.savedTo!);
                            }}
                          >
                            {event.savedTo}
                          </button>
                        )}
                      </details>
                    ) : event.type === "phase" && event.summary ? (
                      <p>{event.summary}</p>
                    ) : event.type === "done" && event.error ? (
                      <p>{event.error}</p>
                    ) : event.type === "approval" ? (
                      <p>{event.title}</p>
                    ) : null}
                  </div>
                </div>
              ))}
              {events.length >= 500 && (
                <p className="field-hint">
                  {t(
                    "Mostrando los últimos 500 eventos. El historial completo se conserva localmente.",
                    "Showing the last 500 events. Full history is retained locally.",
                  )}
                </p>
              )}
            </div>
          )}
        </Card>
      )}
      {tab === "files" && (
        <Card>
          <div className="section-heading">
            <div>
              <h2>{t("Explorador de archivos", "File explorer")}</h2>
              <code className="file-location">{job.workspace}/output</code>
            </div>
            <Button
              variant="ghost"
              busy={busy === "files"}
              onClick={() => void browse(folder?.path ?? ".")}
            >
              <RefreshCw size={14} />
              {t("Actualizar", "Refresh")}
            </Button>
          </div>
          <div className="file-browser">
            <nav aria-label={t("Archivos generados", "Generated files")}>
              <button
                onClick={() =>
                  void browse(
                    (folder?.path ?? ".").split("/").slice(0, -1).join("/") ||
                      ".",
                  )
                }
              >
                <ArrowUp size={15} />
                {t("Subir", "Up")}
              </button>
              {folder?.entries?.map((entry) => (
                <button
                  className={entry.path === file?.path ? "selected" : ""}
                  key={entry.path}
                  onClick={() => void browse(entry.path)}
                >
                  {entry.dir ? <Folder size={15} /> : <FileCode2 size={15} />}
                  {entry.name}
                </button>
              ))}
            </nav>
            <div className="file-preview">
              {file ? (
                <>
                  <div className="file-preview-heading">
                    <code>{file.path}</code>
                    {previousId && !file.binary && (
                      <Button
                        variant="quiet"
                        onClick={async () => {
                          setError("");
                          try {
                            const previous = await api<FileResult>(
                              `/api/jobs/${previousId}/files?path=${encodeURIComponent(file.path)}`,
                            );
                            setDiff(
                              diffLines(
                                previous.content ?? "",
                                file.content ?? "",
                              ),
                            );
                          } catch {
                            setError(
                              t(
                                "Este archivo no existe en la ejecución anterior.",
                                "This file does not exist in the previous run.",
                              ),
                            );
                          }
                        }}
                      >
                        <GitCompareArrows size={14} />
                        {t("Comparar con anterior", "Compare with previous")}
                      </Button>
                    )}
                  </div>
                  {file.binary ? (
                    <p>
                      {t(
                        "Archivo binario. Descargá el ZIP para abrirlo.",
                        "Binary file. Download the ZIP to open it.",
                      )}
                    </p>
                  ) : diff ? (
                    <pre className="diff-view">
                      {diff.map((part, index) => (
                        <span
                          key={index}
                          className={
                            part.added
                              ? "diff-add"
                              : part.removed
                                ? "diff-remove"
                                : ""
                          }
                        >
                          {part.value}
                        </span>
                      ))}
                    </pre>
                  ) : (
                    <pre>
                      <code>{file.content}</code>
                    </pre>
                  )}
                  {file.truncated && (
                    <p className="field-hint">
                      {t(
                        "Vista previa truncada a 1 MB.",
                        "Preview truncated to 1 MB.",
                      )}
                    </p>
                  )}
                </>
              ) : (
                <EmptyState
                  icon={<Code2 size={26} />}
                  title={t("Elegí un archivo", "Choose a file")}
                >
                  {t(
                    "Explorá el código, las notas y la evidencia de la ejecución.",
                    "Explore the code, notes, and evidence from this run.",
                  )}
                </EmptyState>
              )}
            </div>
          </div>
        </Card>
      )}
      {tab === "report" && (
        <Card>
          {report ? (
            <Markdown source={report} />
          ) : (
            <EmptyState
              icon={<FileText size={27} />}
              title={
                busy === "report"
                  ? t("Cargando…", "Loading…")
                  : t(
                      "El informe todavía no está disponible",
                      "The report is not available yet",
                    )
              }
            >
              {t(
                "Aparecerá al finalizar la fase de informe. Los resultados parciales se pueden consultar en Archivos.",
                "It appears after the reporting phase. Partial results are available under Files.",
              )}
            </EmptyState>
          )}
        </Card>
      )}
    </>
  );
}
