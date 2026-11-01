"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  Check,
  Cpu,
  KeyRound,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  SlidersHorizontal,
  ExternalLink,
  ArrowLeft,
} from "lucide-react";
import {
  PROVIDERS,
  providerInfo,
  type ProviderId,
} from "@rea-studio/core/catalog";
import { MODEL_PRESETS } from "@rea-studio/core/pricing";
import type {
  ConnectionRecord,
  ModelRecord,
  StudioSettings,
} from "@rea-studio/core";
import { api, post } from "@/lib/client";
import { dollars, useLocale } from "./Locale";
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  PageTitle,
  Select,
  Tag,
} from "./ui";
import { DirectoryPicker } from "./DirectoryPicker";
export function Settings({
  initialConnections,
  initialModels,
  initialSettings,
  returnToProject = false,
}: {
  initialConnections: ConnectionRecord[];
  initialModels: ModelRecord[];
  initialSettings: StudioSettings;
  returnToProject?: boolean;
}) {
  const { t, locale, setLocale } = useLocale();
  const [connections, setConnections] = useState(initialConnections);
  const [models, setModels] = useState(initialModels);
  const [settings, setSettings] = useState(initialSettings);
  const [tab, setTab] = useState("connections");
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [editing, setEditing] = useState<ConnectionRecord>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  async function saveKey(event: FormEvent) {
    event.preventDefault();
    setBusy("key");
    setError("");
    setSuccess(false);
    try {
      await post("/api/connections", {
        ...(editing ? { id: editing.id } : {}),
        provider,
        name: name || providerInfo(provider).label,
        ...(key ? { apiKey: key } : {}),
        ...(baseURL ? { baseURL } : {}),
      });
      setKey("");
      setName("");
      setBaseURL("");
      setEditing(undefined);
      setConnections(
        (await api<{ connections: ConnectionRecord[] }>("/api/connections"))
          .connections,
      );
      setSuccess(true);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  async function savePreferences(event: FormEvent) {
    event.preventDefault();
    setBusy("preferences");
    setError("");
    try {
      await post("/api/settings", settings);
      setLocale(settings.language);
      setSuccess(true);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  async function removeConnection(id: string) {
    if (
      !confirm(
        t(
          "¿Eliminar esta conexión? Los modelos que la usan deben eliminarse primero.",
          "Delete this connection? Remove models using it first.",
        ),
      )
    )
      return;
    try {
      await api(`/api/connections?id=${id}`, { method: "DELETE" });
      setConnections((items) => items.filter((item) => item.id !== id));
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function testModel(id: string) {
    setBusy(id);
    setError("");
    setSuccess(false);
    try {
      const result = await post<{
        ok: boolean;
        toolCalling: boolean;
        error?: string;
      }>("/api/models/test", { id });
      if (!result.ok || !result.toolCalling)
        throw new Error(
          result.error ||
            t(
              "El modelo no pudo usar herramientas.",
              "The model could not call tools.",
            ),
        );
      setSuccess(true);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {returnToProject && (
        <Link href="/projects/new" prefetch={false} className="back-link">
          <ArrowLeft size={14} />
          {t("Volver a crear el proyecto", "Back to creating your project")}
        </Link>
      )}
      <PageTitle title={t("Configuración", "Settings")}>
        {t(
          "Conectá tus proveedores y definí cómo querés trabajar.",
          "Connect your providers and make this workspace yours.",
        )}
      </PageTitle>
      <div className="tabs" role="tablist">
        {[
          [
            "connections",
            t("Proveedores y claves", "Providers & keys"),
            KeyRound,
          ],
          ["models", t("Modelos y precios", "Models & pricing"), Cpu],
          ["preferences", t("Preferencias", "Preferences"), SlidersHorizontal],
        ].map(([id, label, Icon]) => {
          const I = Icon as typeof KeyRound;
          return (
            <button
              key={String(id)}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(String(id));
                setError("");
                setSuccess(false);
              }}
            >
              <I size={16} />
              {String(label)}
            </button>
          );
        })}
      </div>
      <ErrorNotice message={error} />
      {success && (
        <div className="notice notice-success" role="status">
          <Check size={18} />
          {t(
            "Listo. La operación se completó correctamente.",
            "Done. The operation completed successfully.",
          )}
          {returnToProject && (
            <Link href="/projects/new" prefetch={false} className="text-link">
              {t("Continuar con mi proyecto", "Continue with my project")}
            </Link>
          )}
        </div>
      )}
      {tab === "connections" && (
        <div className="settings-grid">
          <div>
            <Card>
              <div className="section-heading">
                <div>
                  <h2>{t("Tus proveedores de IA", "Your AI providers")}</h2>
                </div>
                <Tag>{connections.length}</Tag>
              </div>
              {connections.length === 0 && (
                <p className="muted py-6">
                  {t(
                    "Agregá tu primera clave para habilitar modelos al crear proyectos.",
                    "Add your first key to enable models when creating projects.",
                  )}
                </p>
              )}
              {connections.map((connection) => (
                <div key={connection.id} className="connection-row">
                  <div
                    className={`provider-tile provider-${connection.provider}`}
                  >
                    {connection.name.slice(0, 1)}
                  </div>
                  <div>
                    <strong>{connection.name}</strong>
                    <small>{providerInfo(connection.provider).label}</small>
                    <span className="key-mask">
                      {connection.hasApiKey
                        ? "•••• •••• •••• ••••"
                        : t(
                            "Sin clave · conexión local",
                            "No key · local connection",
                          )}
                    </span>
                  </div>
                  <div className="connection-actions">
                    <span className="status status-succeeded">
                      <span />
                      {t("Guardada", "Saved")}
                    </span>
                    <button
                      className="text-link"
                      onClick={() => {
                        setEditing(connection);
                        setName(connection.name);
                        setProvider(connection.provider);
                        setBaseURL(connection.baseURL ?? "");
                        setKey("");
                      }}
                    >
                      {t("Editar", "Edit")}
                    </button>
                    <button
                      className="icon-button"
                      aria-label={t(
                        `Eliminar ${connection.name}`,
                        `Delete ${connection.name}`,
                      )}
                      onClick={() => void removeConnection(connection.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </Card>
            <div className="security-note">
              <ShieldCheck size={22} />
              <div>
                <strong>
                  {t(
                    "Las claves se quedan bajo tu control",
                    "Your keys stay under your control",
                  )}
                </strong>
                <p>
                  {t(
                    "Se guardan cifradas en esta máquina y no vuelven al navegador. Guardar una conexión no consume tokens; la prueba de un modelo sí realiza una llamada breve al proveedor.",
                    "Keys are encrypted on this machine and never returned to the browser. Saving a connection uses no tokens; testing a model makes a short provider call.",
                  )}
                </p>
              </div>
            </div>
          </div>
          <Card>
            <div className="section-heading">
              <h2>
                {editing
                  ? t("Editar conexión", "Edit connection")
                  : t("Agregar proveedor", "Add provider")}
              </h2>
              <KeyRound size={20} />
            </div>
            <form onSubmit={saveKey} className="form-stack">
              <Field label={t("Proveedor", "Provider")} htmlFor="provider">
                <Select
                  id="provider"
                  value={provider}
                  disabled={Boolean(editing)}
                  onChange={(event) => {
                    setProvider(event.target.value as ProviderId);
                    setBaseURL("");
                  }}
                >
                  {PROVIDERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t("Nombre de la conexión", "Connection name")}
                htmlFor="connection-name"
              >
                <Input
                  id="connection-name"
                  placeholder={t("Ej. OpenAI personal", "e.g. Personal OpenAI")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field
                label={t("API key", "API key")}
                htmlFor="api-key"
                hint={
                  editing
                    ? t(
                        "Dejá vacío para conservar la clave guardada.",
                        "Leave empty to keep the saved key.",
                      )
                    : t(
                        "La encontrás en el panel de tu proveedor.",
                        "Find it in your provider dashboard.",
                      )
                }
              >
                <Input
                  id="api-key"
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  required={!editing && providerInfo(provider).needsApiKey}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="sk-••••••••••••••••"
                />
              </Field>
              <details open={provider === "openai-compatible"}>
                <summary>
                  {t("Endpoint personalizado", "Custom endpoint")}
                </summary>
                <Field label="Base URL" htmlFor="base-url">
                  <Input
                    id="base-url"
                    type="url"
                    disabled={Boolean(editing)}
                    required={provider === "openai-compatible"}
                    placeholder={
                      providerInfo(provider).defaultBaseURL ||
                      "https://api.example.com/v1"
                    }
                    value={baseURL}
                    onChange={(event) => setBaseURL(event.target.value)}
                  />
                </Field>
              </details>
              <Button type="submit" busy={busy === "key"}>
                <Plus size={16} />
                {t("Guardar conexión", "Save connection")}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => {
                    setEditing(undefined);
                    setKey("");
                    setName("");
                    setBaseURL("");
                  }}
                >
                  {t("Cancelar edición", "Cancel editing")}
                </Button>
              )}
            </form>
          </Card>
        </div>
      )}
      {tab === "models" && (
        <div className="form-stack">
          <Card>
            <div className="section-heading">
              <div>
                <h2>{t("Catálogo de modelos", "Model catalog")}</h2>
                <p>
                  {t(
                    "Tarifas de referencia en USD por 1 millón de tokens de texto.",
                    "Reference rates in USD per 1 million text tokens.",
                  )}
                </p>
              </div>
              <Tag>USD / 1M</Tag>
            </div>
            <div className="table-scroll">
              <table className="pricing-table">
                <thead>
                  <tr>
                    <th>{t("Modelo", "Model")}</th>
                    <th>{t("Proveedor", "Provider")}</th>
                    <th>{t("Entrada", "Input")}</th>
                    <th>{t("Salida", "Output")}</th>
                    <th>{t("Caché", "Cache")}</th>
                    <th>{t("Fuente", "Source")}</th>
                  </tr>
                </thead>
                <tbody>
                  {MODEL_PRESETS.map((preset) => (
                    <tr key={`${preset.provider}:${preset.id}`}>
                      <td>
                        <strong>{preset.name}</strong>
                        <small>{preset.id}</small>
                      </td>
                      <td data-label={t("Proveedor", "Provider")}>
                        {providerInfo(preset.provider).label.split(" (")[0]}
                      </td>
                      <td data-label={t("Entrada", "Input")}>
                        {preset.pricing
                          ? dollars(preset.pricing.input, locale)
                          : "—"}
                      </td>
                      <td data-label={t("Salida", "Output")}>
                        {preset.pricing
                          ? dollars(preset.pricing.output, locale)
                          : "—"}
                      </td>
                      <td data-label={t("Caché", "Cache")}>
                        {preset.pricing?.cachedInput !== undefined
                          ? dollars(preset.pricing.cachedInput, locale)
                          : "—"}
                      </td>
                      <td>
                        {preset.pricing?.source.startsWith("https:") ? (
                          <a
                            className="text-link"
                            href={preset.pricing.source}
                            target="_blank"
                            rel="noreferrer"
                          >
                            models.dev <ExternalLink size={12} />
                          </a>
                        ) : (
                          t("Personalizada", "Custom")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="field-hint mt-4">
              {t(
                "Referencia consultada el 27/10/2026. Las tarifas pueden cambiar. Los contextos largos usan su tarifa correspondiente. No incluye impuestos, herramientas externas, almacenamiento de caché ni hardware local. Los endpoints personalizados requieren sus propias tarifas.",
                "Reference retrieved 2026-10-27. Rates may change. Long contexts use their applicable tier. Excludes taxes, external tools, cache storage, and local hardware. Custom endpoints require their own rates.",
              )}
            </p>
          </Card>
          <Card>
            <h2>{t("Modelos guardados", "Saved models")}</h2>
            <p className="muted">
              {t(
                "Se agregan al elegir un modelo para un proyecto. No se cambian automáticamente.",
                "Added when choosing a model for a project. Never switched automatically.",
              )}
            </p>
            {models.map((model) => (
              <div className="connection-row" key={model.id}>
                <Cpu size={20} />
                <div>
                  <strong>{model.name}</strong>
                  <small>{model.model}</small>
                </div>
                <Button
                  variant="ghost"
                  busy={busy === model.id}
                  onClick={() => void testModel(model.id)}
                >
                  {t("Probar conexión", "Test connection")}
                </Button>
                <button
                  className="icon-button"
                  aria-label={t(
                    `Eliminar ${model.name}`,
                    `Delete ${model.name}`,
                  )}
                  onClick={async () => {
                    if (
                      !confirm(
                        t("¿Eliminar este modelo?", "Delete this model?"),
                      )
                    )
                      return;
                    try {
                      await api(`/api/models/${model.id}`, {
                        method: "DELETE",
                      });
                      setModels((items) =>
                        items.filter((item) => item.id !== model.id),
                      );
                    } catch (cause) {
                      setError(String(cause));
                    }
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </Card>
        </div>
      )}
      {tab === "preferences" && (
        <Card className="preferences-card">
          <form className="form-stack" onSubmit={savePreferences}>
            <div className="section-heading">
              <div>
                <h2>{t("Valores predeterminados", "Defaults")}</h2>
                <p>
                  {t(
                    "Se aplican a proyectos y ejecuciones nuevos.",
                    "Apply to new projects and runs.",
                  )}
                </p>
              </div>
              <SlidersHorizontal size={20} />
            </div>
            <Field label={t("Idioma", "Language")} htmlFor="language">
              <Select
                id="language"
                value={settings.language}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    language: event.target.value as "es" | "en",
                  })
                }
              >
                <option value="es">Español</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label={t("Carpeta predeterminada", "Default folder")}>
              <DirectoryPicker
                value={settings.defaultOutputDirectory}
                onChange={(value) =>
                  setSettings({ ...settings, defaultOutputDirectory: value })
                }
              />
            </Field>
            <Field
              label={t("Modelo predeterminado", "Default model")}
              htmlFor="default-model"
            >
              <Select
                id="default-model"
                value={settings.defaultModelId}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    defaultModelId: event.target.value,
                  })
                }
              >
                <option value="">
                  {t(
                    "Elegir al crear proyecto",
                    "Choose when creating a project",
                  )}
                </option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="form-grid">
              <Field
                label={t("Presupuesto de tokens", "Token budget")}
                htmlFor="default-tokens"
              >
                <Input
                  id="default-tokens"
                  type="number"
                  min={10000}
                  max={10000000}
                  required
                  value={settings.maxTotalTokens}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      maxTotalTokens: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field
                label={t("Pasos por fase", "Steps per phase")}
                htmlFor="default-steps"
              >
                <Input
                  id="default-steps"
                  type="number"
                  min={5}
                  max={500}
                  required
                  value={settings.maxStepsPerPhase}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      maxStepsPerPhase: Number(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.specReview}
                onChange={(event) =>
                  setSettings({ ...settings, specReview: event.target.checked })
                }
              />
              <span>
                {t(
                  "Revisar la especificación antes de construir",
                  "Review the specification before building",
                )}
              </span>
            </label>
            <div className="form-actions">
              <Button type="submit" busy={busy === "preferences"}>
                <Save size={16} />
                {t("Guardar preferencias", "Save preferences")}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
