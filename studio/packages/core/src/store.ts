import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isProviderId, type ProviderId } from "./catalog.js";
import { createSecretBox, loadMasterKey, type SecretBox } from "./crypto.js";
import { createDirectoryTree, studioPaths } from "./paths.js";
import { presetFor, type ModelPricing } from "./pricing.js";
import type {
  ApprovalKind,
  ApprovalRequest,
  JobEvent,
  JobSecrets,
  JobSpec,
  JobStatus,
  ModelConfig,
} from "./types.js";

export interface ModelRecord {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseURL?: string;
  readonly hasApiKey: boolean;
  readonly createdAt: string;
  readonly connectionId?: string;
  readonly pricing?: ModelPricing;
}

export interface ConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderId;
  readonly baseURL?: string;
  readonly hasApiKey: boolean;
  readonly createdAt: string;
}
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly modelId: string;
  readonly outputDirectory: string;
  readonly createdAt: string;
}
export interface StudioSettings {
  readonly language: "es" | "en";
  readonly defaultOutputDirectory: string;
  readonly defaultModelId: string;
  readonly maxTotalTokens: number;
  readonly maxStepsPerPhase: number;
  readonly specReview: boolean;
}

export interface JobUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number;
  readonly unpricedTokens?: number;
}

export interface JobRecord {
  readonly id: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly spec: JobSpec;
  readonly analysisModelId: string;
  readonly buildModelId: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
  readonly usage: JobUsage;
  readonly projectId?: string;
  readonly pricing?: { analysis?: ModelPricing; build?: ModelPricing };
}

export interface StoredEvent {
  readonly seq: number;
  readonly ts: string;
  readonly event: JobEvent;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly jobId: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly note?: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT,
  api_key_enc TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  secrets_enc TEXT NOT NULL,
  analysis_model_id TEXT NOT NULL,
  build_model_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0}'
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_job ON approvals(job_id, status);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
  base_url TEXT, api_key_enc TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  model_id TEXT NOT NULL, output_directory TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data_json TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

const text = (row: Row, key: string): string => String(row[key] ?? "");
const optionalText = (row: Row, key: string): string | undefined =>
  row[key] === null || row[key] === undefined ? undefined : String(row[key]);
const now = (): string => new Date().toISOString();

/** SQLite-backed state shared by the web server and the worker. */
export class StudioStore {
  readonly db: DatabaseSync;
  readonly jobsDir: string;
  readonly #box: SecretBox;

  constructor(home?: string) {
    const paths = studioPaths(home);
    mkdirSync(paths.jobs, { recursive: true, mode: 0o700 });
    this.jobsDir = paths.jobs;
    this.#box = createSecretBox(loadMasterKey(paths.masterKey));
    this.db = new DatabaseSync(paths.database);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Additive migrations preserve installations created before projects existed.
    for (const [table, column] of [
      ["models", "connection_id"],
      ["models", "pricing_json"],
      ["jobs", "project_id"],
      ["jobs", "pricing_json"],
    ]) {
      if (!table || !column) continue;
      const fields = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!fields.some((field) => field.name === column))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }

  close(): void {
    this.db.close();
  }

  getSettings(): StudioSettings {
    const row = this.db
      .prepare("SELECT data_json FROM settings WHERE id = 1")
      .get() as Row | undefined;
    const defaults: StudioSettings = {
      language: "es",
      defaultOutputDirectory: join(this.jobsDir, "..", "projects"),
      defaultModelId: "",
      maxTotalTokens: 200_000,
      maxStepsPerPhase: 60,
      specReview: true,
    };
    return {
      ...defaults,
      ...(row
        ? (JSON.parse(text(row, "data_json")) as Partial<StudioSettings>)
        : {}),
    };
  }

  saveSettings(settings: StudioSettings): StudioSettings {
    this.db
      .prepare(
        "INSERT INTO settings (id, data_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json",
      )
      .run(JSON.stringify(settings));
    return this.getSettings();
  }

  listConnections(): ConnectionRecord[] {
    return this.db
      .prepare("SELECT * FROM connections ORDER BY created_at DESC")
      .all()
      .map((value) => {
        const row = value as Row;
        const baseURL = optionalText(row, "base_url");
        return {
          id: text(row, "id"),
          name: text(row, "name"),
          provider: text(row, "provider") as ProviderId,
          hasApiKey: Boolean(row.api_key_enc),
          createdAt: text(row, "created_at"),
          ...(baseURL ? { baseURL } : {}),
        };
      });
  }

  saveConnection(input: {
    id?: string;
    name: string;
    provider: ProviderId;
    baseURL?: string;
    apiKey?: string;
  }): ConnectionRecord {
    const existing = input.id
      ? this.listConnections().find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("Connection not found.");
    if (
      existing &&
      (existing.provider !== input.provider ||
        (existing.baseURL ?? "") !== (input.baseURL ?? ""))
    )
      throw new Error(
        "Create a new connection to change its provider or endpoint.",
      );
    const id = input.id ?? randomUUID();
    if (existing) {
      this.db
        .prepare(
          "UPDATE connections SET name = ?, api_key_enc = COALESCE(?, api_key_enc) WHERE id = ?",
        )
        .run(
          input.name,
          input.apiKey ? this.#box.seal(input.apiKey) : null,
          id,
        );
    } else {
      this.db
        .prepare("INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          id,
          input.name,
          input.provider,
          input.baseURL || null,
          input.apiKey ? this.#box.seal(input.apiKey) : null,
          now(),
        );
    }
    return this.listConnections().find((item) => item.id === id)!;
  }

  getConnectionConfig(id: string): Omit<ModelConfig, "model"> | undefined {
    const row = this.db
      .prepare("SELECT * FROM connections WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row || !isProviderId(row.provider)) return undefined;
    const key = optionalText(row, "api_key_enc");
    const base = optionalText(row, "base_url");
    return {
      provider: row.provider,
      ...(key ? { apiKey: this.#box.open(key) } : {}),
      ...(base ? { baseURL: base } : {}),
    };
  }

  deleteConnection(id: string): void {
    if (
      this.db
        .prepare("SELECT id FROM models WHERE connection_id = ? LIMIT 1")
        .get(id)
    )
      throw new Error("Remove the saved models using this connection first.");
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at DESC")
      .all()
      .map((value) => {
        const r = value as Row;
        return {
          id: text(r, "id"),
          name: text(r, "name"),
          description: text(r, "description"),
          modelId: text(r, "model_id"),
          outputDirectory: text(r, "output_directory"),
          createdAt: text(r, "created_at"),
        };
      });
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.listProjects().find((project) => project.id === id);
  }

  createProject(input: {
    name: string;
    description: string;
    modelId: string;
    outputDirectory: string;
  }): ProjectRecord {
    if (!this.getModel(input.modelId))
      throw new Error("Choose an available saved model.");
    if (!isAbsolute(input.outputDirectory))
      throw new Error("Choose an absolute folder on this machine.");
    createDirectoryTree(input.outputDirectory);
    const parent = realpathSync(input.outputDirectory);
    accessSync(parent, constants.W_OK);
    const id = randomUUID();
    const slug =
      input.name
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "project";
    const directory = join(parent, `${slug}-${id.slice(0, 8)}`);
    // A fresh owned directory: never merge into or overwrite an existing project.
    mkdirSync(directory, { mode: 0o700 });
    this.db
      .prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.description, input.modelId, directory, now());
    return this.getProject(id)!;
  }

  // Models ------------------------------------------------------------------

  listModels(): ModelRecord[] {
    return this.db
      .prepare("SELECT * FROM models ORDER BY created_at DESC")
      .all()
      .map((row) => this.#modelRecord(row as Row));
  }

  getModel(id: string): ModelRecord | undefined {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    return row ? this.#modelRecord(row as Row) : undefined;
  }

  createModel(input: {
    name: string;
    provider: ProviderId;
    model: string;
    baseURL?: string;
    apiKey?: string;
    connectionId?: string;
    pricing?: ModelPricing;
  }): ModelRecord {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO models (id, name, provider, model, base_url, api_key_enc, created_at, connection_id, pricing_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.provider,
        input.model,
        input.baseURL || null,
        input.apiKey ? this.#box.seal(input.apiKey) : null,
        now(),
        input.connectionId ?? null,
        JSON.stringify(
          input.pricing ??
            (input.baseURL
              ? null
              : presetFor(input.provider, input.model)?.pricing) ??
            null,
        ),
      );
    const created = this.getModel(id);
    if (!created) throw new Error("Model was not stored.");
    return created;
  }

  deleteModel(id: string): void {
    if (
      this.db
        .prepare("SELECT id FROM projects WHERE model_id = ? LIMIT 1")
        .get(id) ||
      this.db
        .prepare(
          "SELECT id FROM jobs WHERE (analysis_model_id = ? OR build_model_id = ?) AND status IN ('queued','running','waiting_approval') LIMIT 1",
        )
        .get(id, id)
    )
      throw new Error("This model is used by a project or an active job.");
    this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
  }

  /** Server-only: the decrypted configuration used to call the provider. */
  getModelConfig(id: string): ModelConfig | undefined {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) return undefined;
    const provider = text(row, "provider");
    if (!isProviderId(provider)) return undefined;
    const sealed = optionalText(row, "api_key_enc");
    const baseURL = optionalText(row, "base_url");
    const connectionId = optionalText(row, "connection_id");
    const connection = connectionId
      ? this.getConnectionConfig(connectionId)
      : undefined;
    if (connectionId && !connection) return undefined;
    const pricing = this.#modelRecord(row).pricing;
    return {
      provider,
      model: text(row, "model"),
      ...(sealed ? { apiKey: this.#box.open(sealed) } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...connection,
      ...(pricing ? { pricing } : {}),
    };
  }

  #modelRecord(row: Row): ModelRecord {
    const provider = text(row, "provider");
    const baseURL = optionalText(row, "base_url");
    const connectionId = optionalText(row, "connection_id");
    const connection = connectionId
      ? this.listConnections().find((item) => item.id === connectionId)
      : undefined;
    const pricing = row.pricing_json
      ? (JSON.parse(String(row.pricing_json)) as ModelPricing | null)
      : undefined;
    return {
      id: text(row, "id"),
      name: text(row, "name"),
      provider: isProviderId(provider) ? provider : "openai-compatible",
      model: text(row, "model"),
      ...(baseURL ? { baseURL } : {}),
      hasApiKey:
        connection?.hasApiKey ?? optionalText(row, "api_key_enc") !== undefined,
      createdAt: text(row, "created_at"),
      ...(connectionId ? { connectionId } : {}),
      ...(pricing ? { pricing } : {}),
    };
  }

  // Jobs --------------------------------------------------------------------

  createJob(input: {
    spec: JobSpec;
    secrets: JobSecrets;
    analysisModelId: string;
    buildModelId: string;
    projectId?: string;
  }): JobRecord {
    const id = randomUUID();
    const project = input.projectId
      ? this.getProject(input.projectId)
      : undefined;
    if (input.projectId && !project) throw new Error("Project not found.");
    const workspace = join(project?.outputDirectory ?? this.jobsDir, id);
    const pricing = {
      analysis: this.getModel(input.analysisModelId)?.pricing,
      build: this.getModel(input.buildModelId)?.pricing,
    };
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO jobs (id, title, status, spec_json, secrets_enc, analysis_model_id, build_model_id, workspace, created_at, updated_at, project_id, pricing_json) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.spec.title,
        JSON.stringify(input.spec),
        this.#box.seal(JSON.stringify(input.secrets)),
        input.analysisModelId,
        input.buildModelId,
        workspace,
        ts,
        ts,
        input.projectId ?? null,
        JSON.stringify(pricing),
      );
    const job = this.getJob(id);
    if (!job) throw new Error("Job was not stored.");
    return job;
  }

  listJobs(limit = 100): JobRecord[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => this.#jobRecord(row as Row));
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? this.#jobRecord(row as Row) : undefined;
  }

  /** Server-only: decrypted target credentials for a job. */
  getJobSecrets(id: string): JobSecrets {
    const row = this.db
      .prepare("SELECT secrets_enc FROM jobs WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return {};
    return JSON.parse(this.#box.open(text(row, "secrets_enc"))) as JobSecrets;
  }

  /** Atomically move the oldest queued job to running. */
  claimNextJob(): JobRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM jobs WHERE status = 'queued' AND cancel_requested = 0 ORDER BY created_at LIMIT 1",
      )
      .get() as Row | undefined;
    if (!row) return undefined;
    const id = text(row, "id");
    const result = this.db
      .prepare(
        "UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(now(), id);
    return Number(result.changes) === 1 ? this.getJob(id) : undefined;
  }

  setJobStatus(id: string, status: JobStatus, error?: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, error ?? null, now(), id);
  }

  setJobUsage(id: string, usage: JobUsage): void {
    this.db
      .prepare("UPDATE jobs SET usage_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(usage), now(), id);
  }

  /** Queued jobs are cancelled at once; running jobs stop at the next check. */
  requestCancel(id: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
      )
      .run(now(), id);
    this.db
      .prepare(
        "UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(now(), id);
  }

  isCancelRequested(id: string): boolean {
    const row = this.db
      .prepare("SELECT cancel_requested FROM jobs WHERE id = ?")
      .get(id) as Row | undefined;
    return Number(row?.cancel_requested ?? 0) === 1;
  }

  /** Jobs left running by a crashed worker are marked failed on startup. */
  failInterruptedJobs(): number {
    const result = this.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error = 'Worker stopped before the job finished.', updated_at = ? WHERE status IN ('running', 'waiting_approval')",
      )
      .run(now());
    return Number(result.changes);
  }

  #jobRecord(row: Row): JobRecord {
    const error = optionalText(row, "error");
    return {
      id: text(row, "id"),
      title: text(row, "title"),
      status: text(row, "status") as JobStatus,
      spec: JSON.parse(text(row, "spec_json")) as JobSpec,
      analysisModelId: text(row, "analysis_model_id"),
      buildModelId: text(row, "build_model_id"),
      workspace: text(row, "workspace"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      ...(error ? { error } : {}),
      usage: JSON.parse(text(row, "usage_json")) as JobUsage,
      ...(row.project_id ? { projectId: text(row, "project_id") } : {}),
      ...(row.pricing_json
        ? {
            pricing: JSON.parse(String(row.pricing_json)) as {
              analysis?: ModelPricing;
              build?: ModelPricing;
            },
          }
        : {}),
    };
  }

  // Events ------------------------------------------------------------------

  appendEvent(jobId: string, event: JobEvent): number {
    const result = this.db
      .prepare(
        "INSERT INTO job_events (job_id, ts, data_json) VALUES (?, ?, ?)",
      )
      .run(jobId, now(), JSON.stringify(event));
    return Number(result.lastInsertRowid);
  }

  listEvents(jobId: string, afterSeq = 0, limit = 500): StoredEvent[] {
    return this.db
      .prepare(
        "SELECT seq, ts, data_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(jobId, afterSeq, limit)
      .map((row) => {
        const r = row as Row;
        return {
          seq: Number(r.seq),
          ts: text(r, "ts"),
          event: JSON.parse(text(r, "data_json")) as JobEvent,
        };
      });
  }

  // Approvals ---------------------------------------------------------------

  createApproval(jobId: string, request: ApprovalRequest): ApprovalRecord {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO approvals (id, job_id, kind, title, detail, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(id, jobId, request.kind, request.title, request.detail, now());
    const created = this.getApproval(id);
    if (!created) throw new Error("Approval was not stored.");
    return created;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? this.#approvalRecord(row as Row) : undefined;
  }

  listApprovals(
    jobId: string,
    status?: ApprovalRecord["status"],
  ): ApprovalRecord[] {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM approvals WHERE job_id = ? AND status = ? ORDER BY created_at",
          )
          .all(jobId, status)
      : this.db
          .prepare(
            "SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at",
          )
          .all(jobId);
    return rows.map((row) => this.#approvalRecord(row as Row));
  }

  decideApproval(id: string, approved: boolean, note?: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(approved ? "approved" : "rejected", note ?? null, now(), id);
    return Number(result.changes) === 1;
  }

  #approvalRecord(row: Row): ApprovalRecord {
    const note = optionalText(row, "note");
    const decidedAt = optionalText(row, "decided_at");
    return {
      id: text(row, "id"),
      jobId: text(row, "job_id"),
      kind: text(row, "kind") as ApprovalKind,
      title: text(row, "title"),
      detail: text(row, "detail"),
      status: text(row, "status") as ApprovalRecord["status"],
      ...(note ? { note } : {}),
      createdAt: text(row, "created_at"),
      ...(decidedAt ? { decidedAt } : {}),
    };
  }
}
