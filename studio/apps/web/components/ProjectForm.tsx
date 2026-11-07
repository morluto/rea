"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  FolderOpen,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  MODEL_PRESETS,
  estimateTokenCost,
  presetFor,
  type ModelPricing,
} from "@rea-studio/core/pricing";
import { providerInfo, type ProviderId } from "@rea-studio/core/catalog";
import type {
  ConnectionRecord,
  ModelRecord,
  ProjectRecord,
  StudioSettings,
} from "@rea-studio/core";
import { post } from "@/lib/client";
import { dollars, number, useLocale } from "./Locale";
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  PageTitle,
  Select,
  Textarea,
  buttonClass,
} from "./ui";
import { DirectoryPicker } from "./DirectoryPicker";
interface Choice {
  key: string;
  name: string;
  model: string;
  provider: ProviderId;
  connectionId?: string;
  savedId?: string;
  pricing?: ModelPricing;
  custom?: boolean;
  context?: number;
}
const DRAFT_KEY = "reall:new-project";
export function ProjectForm({
  connections,
  models,
  settings,
}: {
  connections: ConnectionRecord[];
  models: ModelRecord[];
  settings: StudioSettings;
}) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const choices: Choice[] = [
    ...models.map((model) => ({
      key: `saved:${model.id}`,
      savedId: model.id,
      name: model.name,
      model: model.model,
      provider: model.provider,
      pricing: model.pricing,
      connectionId: model.connectionId,
      context: presetFor(model.provider, model.model)?.context,
    })),
    ...connections.flatMap((connection) => [
      ...MODEL_PRESETS.filter(
        (preset) =>
          preset.provider === connection.provider &&
          !models.some(
            (model) =>
              model.connectionId === connection.id && model.model === preset.id,
          ),
      ).map((preset) => ({
        key: `${connection.id}:${preset.id}`,
        connectionId: connection.id,
        name: preset.name,
        model: preset.id,
        provider: preset.provider,
        context: preset.context,
        ...(!connection.baseURL && preset.pricing
          ? { pricing: preset.pricing }
          : {}),
      })),
      {
        key: `${connection.id}:custom`,
        connectionId: connection.id,
        name: t("Otro modelo", "Custom model"),
        model: "",
        provider: connection.provider,
        custom: true,
      },
    ]),
  ];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState(settings.defaultOutputDirectory);
  const [selection, setSelection] = useState(
    settings.defaultModelId ? `saved:${settings.defaultModelId}` : "",
  );
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [customId, setCustomId] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [sampleInput, setSampleInput] = useState(10000);
  const [sampleOutput, setSampleOutput] = useState(2000);
  const validatedModels = useRef(new Map<string, string>());
  useEffect(() => {
    try {
      const draft: unknown = JSON.parse(
        sessionStorage.getItem(DRAFT_KEY) ?? "null",
      );
      if (draft && typeof draft === "object") {
        const values = draft as Record<string, unknown>;
        for (const [key, setter] of Object.entries({
          name: setName,
          description: setDescription,
          directory: setDirectory,
          selection: setSelection,
          customId: setCustomId,
          inputPrice: setInputPrice,
          outputPrice: setOutputPrice,
        })) {
          if (typeof values[key] === "string")
            setter(values[key].slice(0, 4096));
        }
      }
    } catch {
      /* Browsers may disable local storage; the form still works. */
    }
    setDraftReady(true);
  }, []);
  useEffect(() => {
    if (!draftReady) return;
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          name,
          description,
          directory,
          selection,
          customId,
          inputPrice,
          outputPrice,
        }),
      );
    } catch {
      /* Draft persistence is optional. */
    }
  }, [
    draftReady,
    name,
    description,
    directory,
    selection,
    customId,
    inputPrice,
    outputPrice,
  ]);
  // A preset can become a saved profile while the draft is open in Settings.
  // Resolve the same connection + model instead of silently choosing another.
  const selected =
    choices.find((choice) => choice.key === selection) ??
    choices.find(
      (choice) =>
        choice.savedId &&
        `${choice.connectionId}:${choice.model}` === selection,
    );
  const selectedPricing =
    selected?.pricing ??
    (selected &&
    !selected.savedId &&
    inputPrice !== "" &&
    outputPrice !== "" &&
    Number(inputPrice) >= 0 &&
    Number(outputPrice) >= 0
      ? {
          input: Number(inputPrice),
          output: Number(outputPrice),
          source: "user",
          checkedAt: "",
        }
      : undefined);
  const estimatedCost = estimateTokenCost(
    selectedPricing,
    sampleInput,
    sampleOutput,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) {
      setError(
        t("Elegí un modelo para continuar.", "Choose a model to continue."),
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      let modelId = selected.savedId;
      if (!modelId) {
        const payload = {
          connectionId: selected.connectionId,
          model: selected.custom ? customId : selected.model,
          name: selected.custom ? customId : selected.name,
          ...(!selected.pricing && inputPrice !== "" && outputPrice !== ""
            ? {
                pricing: {
                  input: Number(inputPrice),
                  output: Number(outputPrice),
                },
              }
            : {}),
        };
        const fingerprint = JSON.stringify(payload);
        modelId = validatedModels.current.get(fingerprint);
        if (!modelId) {
          const result = await post<{ model: ModelRecord }>(
            "/api/models",
            payload,
          );
          modelId = result.model.id;
          validatedModels.current.set(fingerprint, modelId);
        }
      }
      const result = await post<{ project: ProjectRecord }>("/api/projects", {
        name,
        description,
        modelId,
        outputDirectory: directory,
      });
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* Storage is optional. */
      }
      router.push(`/projects/${result.project.id}`);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const visible = choices.filter(
    (choice) =>
      (filter === "all" ||
        choice.connectionId === filter ||
        (filter === "saved" && choice.savedId)) &&
      `${choice.name} ${choice.model}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <Link href="/projects" className="back-link">
        <ArrowLeft size={14} />
        {t("Todos los proyectos", "All projects")}
      </Link>
      <PageTitle title={t("Crear proyecto", "Create project")}>
        {t(
          "Dale un nombre, elegí su modelo y decidí dónde vivirá el código.",
          "Give it a name, choose its model, and decide where the code will live.",
        )}
      </PageTitle>
      <form onSubmit={submit} className="project-form">
        <div className="form-stack">
          <Card>
            <div className="form-section-title">
              <span>01</span>
              <div>
                <h2>{t("Tu proyecto", "Your project")}</h2>
                <p>
                  {t(
                    "Un espacio para explorar, construir y mejorar.",
                    "A space to explore, build, and improve.",
                  )}
                </p>
              </div>
            </div>
            <div className="form-stack">
              <Field
                label={t("Nombre del proyecto", "Project name")}
                htmlFor="project-name"
              >
                <Input
                  id="project-name"
                  autoFocus
                  required
                  maxLength={120}
                  placeholder={t(
                    "Ej. Mi próxima gran idea",
                    "e.g. My next great idea",
                  )}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field
                label={t("Descripción · opcional", "Description · optional")}
                htmlFor="project-description"
              >
                <Textarea
                  id="project-description"
                  maxLength={2000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t(
                    "¿Qué querés crear o mejorar?",
                    "What would you like to create or improve?",
                  )}
                />
              </Field>
            </div>
          </Card>
          <Card>
            <div className="form-section-title">
              <span>02</span>
              <div>
                <h2>{t("Elegí tu modelo", "Choose your model")}</h2>
                <p>
                  {t(
                    "Solo conexiones guardadas. El modelo se mantiene durante el flujo.",
                    "Saved connections only. Your model stays selected throughout the workflow.",
                  )}
                </p>
              </div>
            </div>
            {choices.length === 0 ? (
              <div className="inline-empty">
                <KeyRound size={25} />
                <h3>
                  {t(
                    "Primero, conectá un proveedor",
                    "First, connect a provider",
                  )}
                </h3>
                <p>
                  {t(
                    "Cargá una API key en Configuración para ver los modelos disponibles. Lo que escribiste se conserva en esta pestaña.",
                    "Add an API key in Settings to see available models. Your form is kept in this tab.",
                  )}
                </p>
                <Link
                  href="/settings?returnTo=project"
                  className={buttonClass("ghost")}
                >
                  {t("Ir a Configuración", "Go to Settings")}
                  <ArrowRight size={15} />
                </Link>
              </div>
            ) : (
              <>
                <div className="model-filters">
                  <Select
                    aria-label={t(
                      "Filtrar por conexión",
                      "Filter by connection",
                    )}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">
                      {t("Todas las conexiones", "All connections")}
                    </option>
                    {models.length > 0 && (
                      <option value="saved">
                        {t("Modelos guardados", "Saved models")}
                      </option>
                    )}
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </Select>
                  <div className="search-input">
                    <Search size={16} />
                    <Input
                      aria-label={t("Buscar modelo", "Search models")}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("Buscar modelo…", "Search models…")}
                    />
                  </div>
                </div>
                <div
                  className="model-grid"
                  role="radiogroup"
                  aria-label={t("Modelo de IA", "AI model")}
                >
                  {visible.map((choice) => (
                    <label
                      key={choice.key}
                      className={`model-option ${choice.key === selected?.key ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="model"
                        aria-label={`${choice.name} — ${providerInfo(choice.provider).label}`}
                        value={choice.key}
                        checked={choice.key === selected?.key}
                        onChange={() => {
                          setSelection(choice.key);
                          setInputPrice("");
                          setOutputPrice("");
                        }}
                      />
                      <div className="model-top">
                        <span
                          className={`provider-tile provider-${choice.provider}`}
                        >
                          {choice.custom ? (
                            <Plus size={18} />
                          ) : (
                            <Cpu size={18} />
                          )}
                        </span>
                        <span className="model-radio">
                          {choice.key === selected?.key && <Check size={12} />}
                        </span>
                      </div>
                      <strong>{choice.name}</strong>
                      {choice.model && (
                        <code className="model-id">{choice.model}</code>
                      )}
                      <small>
                        {connections.find(
                          (connection) => connection.id === choice.connectionId,
                        )?.name ?? providerInfo(choice.provider).label}
                        {choice.savedId && ` · ${t("Guardado", "Saved")}`}
                      </small>
                      <div className="model-pricing">
                        {choice.pricing ? (
                          <>
                            <span>
                              {t("Entrada", "Input")}{" "}
                              <b>{dollars(choice.pricing.input, locale)}</b>
                            </span>
                            <span>
                              {t("Salida", "Output")}{" "}
                              <b>{dollars(choice.pricing.output, locale)}</b>
                            </span>
                          </>
                        ) : (
                          <span>
                            {t("Tarifa a configurar", "Set your rate")}
                          </span>
                        )}
                      </div>
                      <span className="model-unit">
                        USD / 1M {t("tokens", "tokens")}
                      </span>
                      {choice.context && (
                        <span className="model-context">
                          {t("Contexto", "Context")}:{" "}
                          {number(choice.context, locale)} tokens
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                {visible.length === 0 && (
                  <p className="muted py-5">
                    {t(
                      "No hay modelos con ese filtro.",
                      "No models match this filter.",
                    )}
                  </p>
                )}
              </>
            )}
            {choices.length > 0 && (
              <Link
                className="text-link model-settings-link"
                href="/settings?returnTo=project"
              >
                <Plus size={14} />
                {t("Agregar otra conexión", "Add another connection")}
              </Link>
            )}
            {selected?.custom && (
              <Field
                label={t("ID del modelo", "Model ID")}
                htmlFor="custom-model"
              >
                <Input
                  id="custom-model"
                  required
                  value={customId}
                  onChange={(event) => setCustomId(event.target.value)}
                  placeholder="provider/model-id"
                />
              </Field>
            )}
            {selected && !selected.pricing && !selected.savedId && (
              <div className="custom-pricing">
                <p>
                  {t(
                    "Tarifa opcional, USD por millón. Dejá ambos campos vacíos si no la conocés; se mostrará como costo desconocido.",
                    "Optional rate, USD per million. Leave both fields empty if unknown; cost will be shown as unknown.",
                  )}
                </p>
                <div className="form-grid">
                  <Field
                    label={t("Entrada USD / 1M", "Input USD / 1M")}
                    htmlFor="input-price"
                  >
                    <Input
                      id="input-price"
                      type="number"
                      min="0"
                      step="any"
                      required={outputPrice !== ""}
                      value={inputPrice}
                      onChange={(event) => setInputPrice(event.target.value)}
                    />
                  </Field>
                  <Field
                    label={t("Salida USD / 1M", "Output USD / 1M")}
                    htmlFor="output-price"
                  >
                    <Input
                      id="output-price"
                      type="number"
                      min="0"
                      step="any"
                      required={inputPrice !== ""}
                      value={outputPrice}
                      onChange={(event) => setOutputPrice(event.target.value)}
                    />
                  </Field>
                </div>
              </div>
            )}
            <p className="field-hint mt-5">
              {t(
                "Precios de referencia: 27/10/2026. No incluyen impuestos ni servicios externos. Al guardar un modelo nuevo, probamos su conexión y uso de herramientas con una llamada breve que puede tener costo.",
                "Reference pricing: 2026-10-27. Excludes taxes and external services. Saving a new model tests connectivity and tool calling with a short, potentially billable request.",
              )}
            </p>
          </Card>
          <Card>
            <div className="form-section-title">
              <span>03</span>
              <div>
                <h2>
                  {t("El código, en tu lugar", "Code, in your own place")}
                </h2>
                <p>
                  {t(
                    "Elegí dónde se guardarán las reconstrucciones.",
                    "Choose where your rebuilds will be saved.",
                  )}
                </p>
              </div>
            </div>
            <Field label={t("Carpeta de destino", "Output folder")}>
              <DirectoryPicker value={directory} onChange={setDirectory} />
            </Field>
          </Card>
          <ErrorNotice message={error} />
          <div className="form-actions">
            <Link href="/projects" className={buttonClass("ghost")}>
              {t("Cancelar", "Cancel")}
            </Link>
            <Button
              type="submit"
              busy={busy}
              disabled={!selected || !draftReady}
            >
              {busy
                ? t("Validando y creando…", "Validating and creating…")
                : t("Crear proyecto", "Create project")}
              <ArrowRight size={16} />
            </Button>
          </div>
        </div>
        <aside className="project-summary card">
          <span className="summary-label">
            {t("Resumen del proyecto", "Project summary")}
          </span>
          <h3>{name || t("Tu próximo proyecto", "Your next project")}</h3>
          <div className="summary-item">
            <Cpu size={18} />
            <div>
              <small>{t("Modelo", "Model")}</small>
              <strong>
                {(selected?.custom
                  ? customId || selected.name
                  : selected?.name) || t("Por elegir", "Not selected")}
              </strong>
            </div>
          </div>
          <div className="cost-estimate">
            <h4>{t("Estimación por llamada", "Estimate per call")}</h4>
            <p>
              {t(
                "Compará el costo con la cantidad de tokens que esperás usar.",
                "Compare costs using your expected token counts.",
              )}
            </p>
            <div className="estimate-fields">
              <Field label={t("Entrada", "Input")} htmlFor="estimate-input">
                <Input
                  id="estimate-input"
                  type="number"
                  min={0}
                  max={10000000}
                  step={1}
                  value={sampleInput}
                  onChange={(event) =>
                    setSampleInput(Math.max(0, Number(event.target.value)))
                  }
                />
              </Field>
              <Field label={t("Salida", "Output")} htmlFor="estimate-output">
                <Input
                  id="estimate-output"
                  type="number"
                  min={0}
                  max={10000000}
                  step={1}
                  value={sampleOutput}
                  onChange={(event) =>
                    setSampleOutput(Math.max(0, Number(event.target.value)))
                  }
                />
              </Field>
            </div>
            <output aria-live="polite" className="estimated-total">
              {estimatedCost === undefined
                ? "—"
                : dollars(estimatedCost, locale)}
            </output>
            <small>
              {!selected
                ? t(
                    "Elegí un modelo para calcular.",
                    "Choose a model to calculate.",
                  )
                : !selectedPricing
                  ? t(
                      "Este modelo todavía no tiene una tarifa.",
                      "This model does not have a rate yet.",
                    )
                  : t(
                      "USD, sin caché ni impuestos. Una ejecución puede incluir varias llamadas.",
                      "USD, without cache or taxes. A run can include multiple calls.",
                    )}
            </small>
          </div>
          <div className="summary-item">
            <FolderOpen size={18} />
            <div>
              <small>{t("Destino", "Destination")}</small>
              <code>{directory}</code>
            </div>
          </div>
          <div className="summary-divider" />
          <p>
            {t(
              "Después, elegí qué analizar y qué mejorar. Revisá la especificación antes de construir.",
              "Next, choose what to analyze and improve. Review the specification before building.",
            )}
          </p>
          <div className="summary-assurance">
            <ShieldCheck size={17} />
            {t(
              "Sin sobrescribir proyectos existentes.",
              "Existing projects are never overwritten.",
            )}
          </div>
        </aside>
      </form>
    </>
  );
}
