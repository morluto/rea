"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  Cpu,
  FolderOpen,
  FolderPlus,
  Plus,
  Search,
  Clock3,
} from "lucide-react";
import type { JobRecord, ModelRecord, ProjectRecord } from "@rea-studio/core";
import { useLocale, number } from "./Locale";
import {
  Card,
  EmptyState,
  Input,
  PageTitle,
  StatusPill,
  Tag,
  buttonClass,
} from "./ui";
export function Projects({
  projects,
  jobs,
  models,
}: {
  projects: ProjectRecord[];
  jobs: JobRecord[];
  models: ModelRecord[];
}) {
  const { t, locale } = useLocale();
  const [search, setSearch] = useState("");
  const visible = projects.filter((project) =>
    `${project.name} ${project.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        title={t("Tus proyectos", "Your projects")}
        actions={
          <Link href="/projects/new" className={buttonClass("primary")}>
            <Plus size={17} />
            {t("Crear proyecto", "Create project")}
          </Link>
        }
      >
        {t(
          "Cada idea, con su modelo, su código y su propio camino.",
          "Every idea, with its own model, code, and path forward.",
        )}
      </PageTitle>
      <div className="list-toolbar">
        <div className="search-input">
          <Search size={17} />
          <Input
            aria-label={t("Buscar proyectos", "Search projects")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Buscar proyectos…", "Search projects…")}
          />
        </div>
        <Tag>
          {projects.length} {t("proyectos", "projects")}
        </Tag>
      </div>
      {projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderPlus size={29} />}
            title={t(
              "Tu próxima idea empieza acá",
              "Your next idea starts here",
            )}
            action={
              <Link href="/projects/new" className={buttonClass("primary")}>
                {t("Crear primer proyecto", "Create first project")}
                <ArrowRight size={16} />
              </Link>
            }
          >
            {t(
              "Organizá tus reconstrucciones, elegí un modelo y mantené todo tu código en una carpeta propia.",
              "Organize your rebuilds, choose a model, and keep all your code in a folder of your own.",
            )}
          </EmptyState>
        </Card>
      ) : (
        <div className="projects-grid">
          {visible.map((project) => {
            const projectJobs = jobs.filter(
              (job) => job.projectId === project.id,
            );
            const model = models.find((item) => item.id === project.modelId);
            return (
              <Link
                href={`/projects/${project.id}`}
                key={project.id}
                className="project-card card"
              >
                <div className="project-card-top">
                  <span className="project-folder">
                    <FolderOpen size={23} />
                  </span>
                  <ArrowRight size={18} />
                </div>
                <h2>{project.name}</h2>
                <p>
                  {project.description ||
                    t(
                      "Listo para tu próxima reconstrucción.",
                      "Ready for your next rebuild.",
                    )}
                </p>
                <div className="project-meta">
                  <span>
                    <Cpu size={14} />
                    {model?.name ||
                      t("Modelo no disponible", "Model unavailable")}
                  </span>
                  <span>
                    <Clock3 size={14} />
                    {new Date(project.createdAt).toLocaleDateString(locale)}
                  </span>
                </div>
                <div className="project-card-bottom">
                  <span>
                    {projectJobs.length} {t("ejecuciones", "runs")}
                  </span>
                  {projectJobs[0] ? (
                    <StatusPill status={projectJobs[0].status} />
                  ) : (
                    <Tag>{t("Nuevo", "New")}</Tag>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {projects.length > 0 && visible.length === 0 && (
        <p className="muted py-8">
          {t(
            "No encontramos proyectos con ese nombre.",
            "No projects match that name.",
          )}
        </p>
      )}
      {jobs.some((job) => !job.projectId) && (
        <Card className="mt-8">
          <h2>{t("Ejecuciones anteriores", "Previous runs")}</h2>
          <p className="muted">
            {t(
              "Los trabajos existentes se conservan sin cambios.",
              "Existing jobs are preserved unchanged.",
            )}
          </p>
          <div className="job-list">
            {jobs
              .filter((job) => !job.projectId)
              .map((job) => (
                <Link href={`/jobs/${job.id}`} key={job.id} className="job-row">
                  <strong>{job.title}</strong>
                  <span>{number(job.usage.totalTokens, locale)} tok</span>
                  <StatusPill status={job.status} />
                  <ArrowRight size={16} />
                </Link>
              ))}
          </div>
        </Card>
      )}
    </>
  );
}
export function ProjectDetail({
  project,
  jobs,
  model,
}: {
  project: ProjectRecord;
  jobs: JobRecord[];
  model?: ModelRecord;
}) {
  const { t, locale } = useLocale();
  return (
    <>
      <Link href="/projects" className="back-link">
        ← {t("Proyectos", "Projects")}
      </Link>
      <PageTitle
        title={project.name}
        actions={
          <Link
            href={`/jobs/new?project=${project.id}`}
            className={buttonClass("primary")}
          >
            <Plus size={16} />
            {t("Nueva ejecución", "New run")}
          </Link>
        }
      >
        {project.description}
      </PageTitle>
      <div className="project-overview">
        <Card>
          <Cpu size={20} />
          <span>{t("Modelo seleccionado", "Selected model")}</span>
          <strong>{model?.name || t("No disponible", "Unavailable")}</strong>
          <small>{model?.model}</small>
        </Card>
        <Card>
          <FolderOpen size={20} />
          <span>{t("Carpeta del proyecto", "Project folder")}</span>
          <code>{project.outputDirectory}</code>
          <small>
            {t(
              "Cada ejecución guarda su código en <id>/output/.",
              "Each run saves its code in <id>/output/.",
            )}
          </small>
        </Card>
        <Card>
          <Clock3 size={20} />
          <span>{t("Tokens acumulados", "Total tokens")}</span>
          <strong>
            {number(
              jobs.reduce((sum, job) => sum + job.usage.totalTokens, 0),
              locale,
            )}
          </strong>
          <small>
            {jobs.length} {t("ejecuciones", "runs")}
          </small>
        </Card>
      </div>
      <Card>
        <div className="section-heading">
          <h2>{t("Historial de ejecuciones", "Run history")}</h2>
          <Tag>{jobs.length}</Tag>
        </div>
        {jobs.length === 0 ? (
          <EmptyState
            icon={<FolderPlus size={26} />}
            title={t("Todo listo para empezar", "Ready when you are")}
            action={
              <Link
                href={`/jobs/new?project=${project.id}`}
                className={buttonClass("primary")}
              >
                {t("Configurar primera ejecución", "Set up first run")}
                <ArrowRight size={16} />
              </Link>
            }
          >
            {t(
              "Elegí el objetivo y las mejoras. Reall se encarga del flujo de análisis a verificación.",
              "Choose the target and improvements. Reall takes you from analysis to verification.",
            )}
          </EmptyState>
        ) : (
          <div className="job-list">
            {jobs.map((job) => (
              <Link href={`/jobs/${job.id}`} key={job.id} className="job-row">
                <div>
                  <strong>{job.title}</strong>
                  <small>
                    {new Date(job.createdAt).toLocaleString(locale)}
                  </small>
                </div>
                <span>{number(job.usage.totalTokens, locale)} tok</span>
                <StatusPill status={job.status} />
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
