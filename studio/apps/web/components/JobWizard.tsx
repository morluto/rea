"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  Cpu,
  Globe2,
  LockKeyhole,
  Monitor,
  Play,
  Smartphone,
  Upload,
  ShieldCheck,
} from "lucide-react";
import {
  LANGUAGES,
  type AccessMode,
  type HardeningId,
  type ScopeMode,
  type TargetKind,
} from "@rea-studio/core/catalog";
import type {
  JobRecord,
  ModelRecord,
  ProjectRecord,
  StudioSettings,
} from "@rea-studio/core";
import { api } from "@/lib/client";
import { useLocale } from "./Locale";
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  PageTitle,
  Select,
  Textarea,
} from "./ui";
export function JobWizard({
  project,
  models,
  settings,
  workerAlive,
}: {
  project: ProjectRecord;
  models: ModelRecord[];
  settings: StudioSettings;
  workerAlive: boolean;
}) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TargetKind>("web");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [file, setFile] = useState<File>();
  const [access, setAccess] = useState<AccessMode>("none");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [cookies, setCookies] = useState("");
  const [cdpPort, setCdpPort] = useState(9222);
  const [scope, setScope] = useState<ScopeMode>("full");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("");
  const [framework, setFramework] = useState("");
  const [stack, setStack] = useState("");
  const [hardening, setHardening] = useState<HardeningId[]>(["tests"]);
  const [instructions, setInstructions] = useState("");
  const [tokens, setTokens] = useState(settings.maxTotalTokens);
  const [maxSteps, setMaxSteps] = useState(settings.maxStepsPerPhase);
  const [maxCost, setMaxCost] = useState("");
  const [specReview, setSpecReview] = useState(settings.specReview);
  const [permissionMode, setPermissionMode] = useState<"ask" | "auto" | "">("");
  const [authorized, setAuthorized] = useState(false);
  const [buildModel, setBuildModel] = useState(project.modelId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedModel = models.find((model) => model.id === project.modelId);
  const steps = [
    t("Objetivo", "Target"),
    t("Acceso", "Access"),
    t("Alcance", "Scope"),
    t("Mejoras", "Improvements"),
    t("Revisar", "Review"),
  ];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (step < 4) {
      if (step === 0 && kind !== "web" && !path && !file) {
        setError(
          t(
            "Elegí un archivo o una ruta local.",
            "Choose a file or a local path.",
          ),
        );
        return;
      }
      setStep(step + 1);
      return;
    }
    if (!permissionMode) {
      setError(
        t(
          "Elegí cómo autorizar esta ejecución.",
          "Choose how to authorize this run.",
        ),
      );
      return;
    }
    setBusy(true);
    try {
      const spec = {
        title,
        language: locale,
        target: { kind, ...(kind === "web" ? { url } : path ? { path } : {}) },
        access: {
          mode: kind === "web" ? access : "none",
          ...(loginUrl ? { loginUrl } : {}),
          ...(access === "connect" ? { cdpPort } : {}),
        },
        scope: { mode: scope, description },
        enhancement: {
          ...(language
            ? { port: { language, ...(framework ? { framework } : {}) } }
            : {}),
          ...(stack ? { stack } : {}),
          hardening,
          ...(instructions ? { instructions } : {}),
        },
        budget: {
          maxStepsPerPhase: maxSteps,
          maxTotalTokens: tokens,
          ...(maxCost ? { maxCostUsd: Number(maxCost) } : {}),
        },
        approvals: {
          destructiveTools: permissionMode,
          commands: permissionMode,
          specReview: permissionMode === "auto" ? false : specReview,
        },
        authorizationAttested: authorized,
      };
      const form = new FormData();
      form.set(
        "job",
        JSON.stringify({
          projectId: project.id,
          analysisModelId: project.modelId,
          buildModelId: buildModel,
          spec,
          secrets: { username, password, cookiesJson: cookies },
        }),
      );
      if (file && kind !== "web") form.set("artifact", file);
      const result = await api<{ job: JobRecord }>("/api/jobs", {
        method: "POST",
        body: form,
      });
      setPassword("");
      setCookies("");
      router.push(`/jobs/${result.job.id}`);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" href={`/projects/${project.id}`}>
        <ArrowLeft size={14} />
        {project.name}
      </Link>
      <PageTitle title={t("¿Qué vamos a construir?", "What are we building?")}>
        {t(
          "Definí el objetivo. Reall te acompaña del análisis al código verificado.",
          "Define the target. Reall takes you from analysis to verified code.",
        )}
      </PageTitle>
      <ol className="wizard-steps">
        {steps.map((label, index) => (
          <li
            key={label}
            className={
              index === step ? "current" : index < step ? "complete" : ""
            }
          >
            <button disabled={index > step} onClick={() => setStep(index)}>
              <span>{index < step ? <Check size={14} /> : index + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="wizard-layout">
        <Card className="wizard-panel">
          <ErrorNotice message={error} />
          {step === 0 && (
            <div className="form-stack">
              <h2>{t("Empezá por el original", "Start with the original")}</h2>
              <Field
                label={t("Nombre de la ejecución", "Run name")}
                htmlFor="run-name"
              >
                <Input
                  id="run-name"
                  required
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t(
                    "Ej. Reconstruir el buscador de notas",
                    "e.g. Rebuild the notes search",
                  )}
                />
              </Field>
              <div className="target-grid">
                {(
                  [
                    ["web", t("Aplicación web", "Web application"), Globe2],
                    ["javascript", "Electron / JavaScript", Code2],
                    ["android", "Android APK", Smartphone],
                    ["native", t("Binario nativo", "Native binary"), Monitor],
                  ] as const
                ).map(([value, label, Icon]) => (
                  <label
                    key={value}
                    className={`target-option ${kind === value ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === value}
                      onChange={() => setKind(value)}
                    />
                    <Icon size={23} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              {kind === "web" ? (
                <Field
                  label={t("URL de la aplicación", "Application URL")}
                  htmlFor="target-url"
                >
                  <Input
                    id="target-url"
                    type="url"
                    required
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://app.example.com"
                  />
                </Field>
              ) : (
                <>
                  <Field
                    label={t(
                      "Ruta absoluta en esta máquina",
                      "Absolute path on this machine",
                    )}
                    htmlFor="target-path"
                  >
                    <Input
                      id="target-path"
                      value={path}
                      onChange={(event) => {
                        setPath(event.target.value);
                        setFile(undefined);
                      }}
                      placeholder="/path/to/application"
                    />
                  </Field>
                  <div className="upload-area">
                    <Upload size={22} />
                    <label htmlFor="artifact">
                      {t("O subí un archivo", "Or upload a file")}
                    </label>
                    <input
                      id="artifact"
                      type="file"
                      onChange={(event) => {
                        setFile(event.target.files?.[0]);
                        setPath("");
                      }}
                    />
                    <small>
                      {file?.name ||
                        t(
                          "ASAR, JavaScript, APK o ejecutable. Para carpetas, usá la ruta local.",
                          "ASAR, JavaScript, APK, or executable. Use a local path for directories.",
                        )}
                    </small>
                  </div>
                  {kind === "native" && (
                    <p className="field-hint">
                      {t(
                        "Requiere tu instalación de Ghidra, Hopper o IDA.",
                        "Requires your installation of Ghidra, Hopper, or IDA.",
                      )}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {step === 1 && (
            <div className="form-stack">
              <h2>{t("Acceso al objetivo", "Target access")}</h2>
              {kind !== "web" ? (
                <div className="inline-empty">
                  <ShieldCheck size={28} />
                  <h3>
                    {t("Análisis de archivo local", "Local artifact analysis")}
                  </h3>
                  <p>
                    {t(
                      "Este objetivo no necesita credenciales web.",
                      "This target does not need web credentials.",
                    )}
                  </p>
                </div>
              ) : (
                <>
                  <Field
                    label={t("Método de acceso", "Access method")}
                    htmlFor="access-method"
                  >
                    <Select
                      id="access-method"
                      value={access}
                      onChange={(event) =>
                        setAccess(event.target.value as AccessMode)
                      }
                    >
                      <option value="none">
                        {t("Público · sin login", "Public · no login")}
                      </option>
                      <option value="password">
                        {t("Usuario y contraseña", "Username and password")}
                      </option>
                      <option value="storage">
                        {t("Cookies exportadas", "Exported cookies")}
                      </option>
                      <option value="connect">
                        {t(
                          "Ya inicié sesión en Chrome (MFA)",
                          "Already signed in to Chrome (MFA)",
                        )}
                      </option>
                    </Select>
                  </Field>
                  {access === "password" && (
                    <>
                      <Field
                        label={t(
                          "URL del login · opcional",
                          "Login URL · optional",
                        )}
                        htmlFor="login-url"
                      >
                        <Input
                          id="login-url"
                          type="url"
                          value={loginUrl}
                          onChange={(event) => setLoginUrl(event.target.value)}
                        />
                      </Field>
                      <Field
                        label={t("Usuario", "Username")}
                        htmlFor="target-user"
                      >
                        <Input
                          id="target-user"
                          autoComplete="off"
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                        />
                      </Field>
                      <Field
                        label={t("Contraseña", "Password")}
                        htmlFor="target-password"
                      >
                        <Input
                          id="target-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  {access === "storage" && (
                    <Field
                      label={t("Cookies en JSON", "Cookies as JSON")}
                      htmlFor="cookies"
                      hint={t(
                        "Array de objetos con name, value, domain y path.",
                        "Array of objects with name, value, domain, and path.",
                      )}
                    >
                      <Textarea
                        id="cookies"
                        required
                        value={cookies}
                        onChange={(event) => setCookies(event.target.value)}
                        spellCheck={false}
                      />
                    </Field>
                  )}
                  {access === "connect" && (
                    <>
                      <p className="muted">
                        {t(
                          "Abrí Chrome con un puerto de depuración local, iniciá sesión y mantenelo abierto. Reall se conectará a ese navegador.",
                          "Open Chrome with a local debugging port, sign in, and keep it open. Reall will connect to that browser.",
                        )}
                      </p>
                      <Field
                        label={t("Puerto de depuración", "Debugging port")}
                        htmlFor="cdp-port"
                      >
                        <Input
                          id="cdp-port"
                          type="number"
                          required
                          min={1}
                          max={65535}
                          value={cdpPort}
                          onChange={(event) =>
                            setCdpPort(Number(event.target.value))
                          }
                        />
                      </Field>
                    </>
                  )}
                  <div className="security-note">
                    <LockKeyhole size={20} />
                    <p>
                      {t(
                        "Las credenciales del objetivo se cifran. El modelo recibe referencias, no los valores.",
                        "Target credentials are encrypted. The model receives references, not their values.",
                      )}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="form-stack">
              <h2>{t("Elegí qué reconstruir", "Choose what to rebuild")}</h2>
              {(
                [
                  [
                    "full",
                    t("La aplicación completa", "The whole application"),
                    t(
                      "Reproducí sus flujos y funcionalidades principales.",
                      "Reproduce its primary workflows and features.",
                    ),
                  ],
                  [
                    "feature",
                    t("Una funcionalidad", "One feature"),
                    t(
                      "Enfocá el análisis en lo que más te interesa.",
                      "Focus the analysis on what matters most.",
                    ),
                  ],
                  [
                    "api",
                    t("API y backend", "API and backend"),
                    t(
                      "Concentrate en contratos, datos y comportamiento.",
                      "Focus on contracts, data, and behavior.",
                    ),
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={`choice-row ${scope === value ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === value}
                    onChange={() => setScope(value)}
                  />
                  <div>
                    <strong>{label}</strong>
                    <p>{hint}</p>
                  </div>
                </label>
              ))}
              <Field
                label={t("Detalles del alcance", "Scope details")}
                htmlFor="scope-description"
              >
                <Textarea
                  id="scope-description"
                  required={scope === "feature"}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={4000}
                  placeholder={t(
                    "Flujos, pantallas o comportamientos importantes…",
                    "Important flows, screens, or behaviors…",
                  )}
                />
              </Field>
            </div>
          )}
          {step === 3 && (
            <div className="form-stack">
              <h2>{t("Hacelo todavía mejor", "Make it even better")}</h2>
              <div className="form-grid">
                <Field
                  label={t("Lenguaje de destino", "Target language")}
                  htmlFor="target-language"
                >
                  <Select
                    id="target-language"
                    value={language}
                    onChange={(event) => {
                      setLanguage(event.target.value);
                      setFramework("");
                    }}
                  >
                    <option value="">
                      {t(
                        "Conservar / dejar al agente",
                        "Keep / let the agent choose",
                      )}
                    </option>
                    {LANGUAGES.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Framework" htmlFor="framework">
                  <Select
                    id="framework"
                    value={framework}
                    disabled={!language}
                    onChange={(event) => setFramework(event.target.value)}
                  >
                    <option value="">
                      {t("Sin preferencia", "No preference")}
                    </option>
                    {LANGUAGES.find(
                      (item) => item.id === language,
                    )?.frameworks.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field
                label={t(
                  "Cambio de stack · opcional",
                  "Stack change · optional",
                )}
                htmlFor="stack"
              >
                <Input
                  id="stack"
                  maxLength={400}
                  value={stack}
                  onChange={(event) => setStack(event.target.value)}
                  placeholder={t(
                    "Ej. React SPA a Next.js con PostgreSQL",
                    "e.g. React SPA to Next.js with PostgreSQL",
                  )}
                />
              </Field>
              <div className="check-grid">
                {(
                  [
                    ["tests", t("Tests automatizados", "Automated tests")],
                    ["security", t("Seguridad", "Security")],
                    ["accessibility", t("Accesibilidad", "Accessibility")],
                    ["performance", t("Rendimiento", "Performance")],
                  ] as const
                ).map(([id, label]) => (
                  <label className="check-row" key={id}>
                    <input
                      type="checkbox"
                      checked={hardening.includes(id)}
                      onChange={(event) =>
                        setHardening(
                          event.target.checked
                            ? [...hardening, id]
                            : hardening.filter((item) => item !== id),
                        )
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <Field
                label={t(
                  "Instrucciones adicionales",
                  "Additional instructions",
                )}
                htmlFor="instructions"
              >
                <Textarea
                  id="instructions"
                  value={instructions}
                  maxLength={4000}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={t(
                    "Contanos qué haría especial esta versión…",
                    "Tell us what would make this version special…",
                  )}
                />
              </Field>
            </div>
          )}
          {step === 4 && (
            <div className="form-stack">
              <h2>
                {t(
                  "Todo listo. Vos tenés el control.",
                  "All set. You are in control.",
                )}
              </h2>
              <div className="review-summary">
                <strong>{title}</strong>
                <p>{kind === "web" ? url : file?.name || path}</p>
                <span>
                  {selectedModel?.name} →{" "}
                  {language || t("Stack original", "Original stack")}
                  {framework && ` / ${framework}`}
                </span>
              </div>
              <div className="form-grid">
                <Field
                  label={t("Máximo de tokens", "Maximum tokens")}
                  htmlFor="max-tokens"
                >
                  <Input
                    id="max-tokens"
                    required
                    type="number"
                    min={10000}
                    max={10000000}
                    value={tokens}
                    onChange={(event) => setTokens(Number(event.target.value))}
                  />
                </Field>
                <Field
                  label={t(
                    "Máximo de pasos por fase",
                    "Maximum steps per phase",
                  )}
                  htmlFor="max-steps"
                >
                  <Input
                    id="max-steps"
                    required
                    type="number"
                    min={5}
                    max={500}
                    value={maxSteps}
                    onChange={(event) =>
                      setMaxSteps(Number(event.target.value))
                    }
                  />
                </Field>
              </div>
              <Field
                label={t(
                  "Presupuesto estimado USD · opcional",
                  "Estimated USD budget · optional",
                )}
                htmlFor="max-cost"
                hint={t(
                  "Se evalúa al terminar cada llamada. La última llamada puede superar el límite. No equivale a un límite de facturación del proveedor.",
                  "Checked after each call. The final call can exceed the limit. This is not a provider billing cap.",
                )}
              >
                <Input
                  id="max-cost"
                  type="number"
                  min="0.01"
                  max="10000"
                  step="0.01"
                  disabled={
                    !selectedModel?.pricing ||
                    !models.find((model) => model.id === buildModel)?.pricing
                  }
                  value={maxCost}
                  onChange={(event) => setMaxCost(event.target.value)}
                  placeholder={
                    selectedModel?.pricing
                      ? "5.00"
                      : t(
                          "Requiere tarifas configuradas",
                          "Requires configured rates",
                        )
                  }
                />
              </Field>
              <details>
                <summary>{t("Modelo de construcción", "Build model")}</summary>
                <div className="form-stack">
                  <Field
                    label={t("Modelo para construir", "Model for building")}
                    htmlFor="build-model"
                  >
                    <Select
                      id="build-model"
                      value={buildModel}
                      onChange={(event) => {
                        setBuildModel(event.target.value);
                        setMaxCost("");
                      }}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                          {model.id === project.modelId
                            ? t(" · mismo modelo", " · same model")
                            : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </details>
              <fieldset className="permission-choice">
                <legend>
                  {t("Permisos de esta ejecución", "Permissions for this run")}
                </legend>
                <p className="field-hint">
                  {t(
                    "Elegí cómo querés que Reall ejecute el trabajo.",
                    "Choose how Reall should carry out this run.",
                  )}
                </p>
                <label
                  className={`permission-option ${permissionMode === "auto" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="permission-mode"
                    value="auto"
                    required
                    checked={permissionMode === "auto"}
                    onChange={() => setPermissionMode("auto")}
                  />
                  <span>
                    <strong>
                      {t(
                        "Autorizar toda la ejecución",
                        "Authorize the entire run",
                      )}
                    </strong>
                    <small>
                      {t(
                        "Doy permiso para ejecutar comandos y herramientas, instalar dependencias y modificar o eliminar archivos sin pedirme aprobación en cada paso. Incluye todas las fases de esta ejecución, con los permisos de mi usuario en esta máquina.",
                        "I allow commands and tools, dependency installation, and file changes or deletion without approval at each step. This covers all phases of this run, using my user's permissions on this machine.",
                      )}
                    </small>
                  </span>
                </label>
                <label
                  className={`permission-option ${permissionMode === "ask" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="permission-mode"
                    value="ask"
                    required
                    checked={permissionMode === "ask"}
                    onChange={() => setPermissionMode("ask")}
                  />
                  <span>
                    <strong>
                      {t("Aprobar paso por paso", "Approve step by step")}
                    </strong>
                    <small>
                      {t(
                        "Reall me pedirá aprobación antes de cada comando y herramienta con efectos destructivos. Las lecturas y la generación de archivos del proyecto continúan automáticamente.",
                        "Reall will ask before each command and tool with destructive effects. Reading and generating project files continue automatically.",
                      )}
                    </small>
                  </span>
                </label>
              </fieldset>
              {permissionMode !== "auto" && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={specReview}
                    onChange={(event) => setSpecReview(event.target.checked)}
                  />
                  {t(
                    "Quiero revisar la especificación antes de construir",
                    "I want to review the specification before building",
                  )}
                </label>
              )}
              <label className="check-row authorization">
                <input
                  type="checkbox"
                  required
                  checked={authorized}
                  onChange={(event) => setAuthorized(event.target.checked)}
                />
                {t(
                  "Soy dueño del objetivo o tengo permiso para analizarlo y reproducirlo.",
                  "I own the target or have permission to analyze and reproduce it.",
                )}
              </label>
              {!workerAlive && (
                <p className="notice notice-warning">
                  {t(
                    "El worker no está activo. La ejecución quedará en cola hasta que inicies Reall con npm run studio.",
                    "The worker is offline. This run will stay queued until Reall starts with npm run studio.",
                  )}
                </p>
              )}
            </div>
          )}
          <div className="form-actions wizard-actions">
            <Button
              variant="ghost"
              type="button"
              disabled={step === 0 || busy}
              onClick={() => {
                setError("");
                setStep(step - 1);
              }}
            >
              <ArrowLeft size={15} />
              {t("Atrás", "Back")}
            </Button>
            <Button type="submit" busy={busy}>
              {step === 4 ? (
                <>
                  <Play size={15} />
                  {t("Iniciar ejecución", "Start run")}
                </>
              ) : (
                <>
                  {t("Continuar", "Continue")}
                  <ArrowRight size={15} />
                </>
              )}
            </Button>
          </div>
        </Card>
        <aside className="project-summary card">
          <h3>{project.name}</h3>
          <div className="summary-item">
            <Cpu size={18} />
            <div>
              <small>{t("Modelo de análisis", "Analysis model")}</small>
              <strong>{selectedModel?.name}</strong>
            </div>
          </div>
          <div className="summary-divider" />
          <ol className="pipeline-preview">
            {[
              t("Análisis", "Analysis"),
              t("Especificación", "Specification"),
              t("Construcción", "Build"),
              t("Verificación", "Verification"),
              t("Informe", "Report"),
            ].map((label, index) => (
              <li key={label}>
                <span>{index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <p className="field-hint">
            {t(
              "Seguí cada etapa, revisá las aprobaciones y descargá tu código al terminar.",
              "Follow each phase, review approvals, and download your code when finished.",
            )}
          </p>
        </aside>
      </form>
    </>
  );
}
