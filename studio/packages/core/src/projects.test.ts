import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StudioStore } from "./store.js";
import { estimateTokenCost, presetFor } from "./pricing.js";
import { parseJobSpec } from "./validation.js";
const roots: string[] = [];
const stores: StudioStore[] = [];
const open = () => {
  const root = mkdtempSync(join(tmpdir(), "reall-projects-"));
  roots.push(root);
  const store = new StudioStore(root);
  stores.push(store);
  return { root, store };
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const spec = parseJobSpec({
  title: "Fixture",
  target: { kind: "javascript", path: "/fixture" },
  access: { mode: "none" },
  scope: { mode: "full", description: "" },
  enhancement: { hardening: [] },
  budget: { maxStepsPerPhase: 5 },
  approvals: { specReview: true },
  authorizationAttested: true,
});
describe("projects and saved connections", () => {
  it.skipIf(process.platform !== "linux")(
    "rejects an unwritable virtual directory without hanging the server",
    () => {
      const moduleUrl = new URL("./paths.ts", import.meta.url).href;
      const script = `import { createDirectoryTree } from ${JSON.stringify(moduleUrl)}; try { createDirectoryTree('/proc/reall-directory-regression'); process.exitCode = 2; } catch (error) { if (!['ENOENT', 'EACCES', 'EROFS', 'EPERM'].includes(error.code)) throw error; }`;
      // Keep the regression in a bounded child so a recursive-mkdir regression
      // cannot hang the test runner itself.
      expect(() =>
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          timeout: 3000,
          stdio: "pipe",
        }),
      ).not.toThrow();
    },
  );
  it("keeps keys encrypted, rotates them without exposing or changing a selected model", () => {
    const { store, root } = open();
    const connection = store.saveConnection({
      name: "Test",
      provider: "openai",
      apiKey: "test-only-secret-one",
    });
    const model = store.createModel({
      name: "Selected",
      provider: "openai",
      model: "gpt-5-mini",
      connectionId: connection.id,
    });
    expect(
      JSON.stringify(store.listConnections()) +
        JSON.stringify(store.listModels()),
    ).not.toContain("test-only-secret");
    expect(store.getModelConfig(model.id)?.apiKey).toBe("test-only-secret-one");
    store.saveConnection({
      id: connection.id,
      name: "Updated",
      provider: "openai",
      apiKey: "test-only-secret-two",
    });
    expect(store.getModelConfig(model.id)).toMatchObject({
      model: "gpt-5-mini",
      apiKey: "test-only-secret-two",
    });
    expect(
      String(
        store.db.prepare("SELECT api_key_enc FROM connections").get()
          ?.api_key_enc,
      ),
    ).not.toContain("test-only-secret");
    expect(statSync(join(root, "master.key")).mode & 0o777).toBe(0o600);
    expect(() => store.deleteConnection(connection.id)).toThrow(/models/);
  });
  it("creates isolated project folders under the chosen parent and snapshots prices for jobs", () => {
    const { store, root } = open();
    const model = store.createModel({
      name: "GPT",
      provider: "openai",
      model: "gpt-5-mini",
    });
    const input = {
      name: "My project",
      description: "Test",
      modelId: model.id,
      outputDirectory: join(root, "chosen"),
    };
    const a = store.createProject(input);
    const b = store.createProject(input);
    expect(a.outputDirectory).not.toBe(b.outputDirectory);
    expect(a.outputDirectory.startsWith(join(root, "chosen") + "/")).toBe(true);
    const job = store.createJob({
      spec,
      secrets: {},
      analysisModelId: model.id,
      buildModelId: model.id,
      projectId: a.id,
    });
    expect(job.workspace).toBe(join(a.outputDirectory, job.id));
    expect(job.pricing?.analysis).toEqual(model.pricing);
    store.db
      .prepare("UPDATE models SET pricing_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...model.pricing, input: 99 }), model.id);
    expect(store.getJob(job.id)?.pricing?.analysis?.input).toBe(0.25);
    expect(() => store.deleteModel(model.id)).toThrow(/project/);
  });
  it("rejects invalid destinations and missing models before creating project state", () => {
    const { store } = open();
    const model = store.createModel({
      name: "local",
      provider: "ollama",
      model: "qwen3-coder:30b",
    });
    expect(() =>
      store.createProject({
        name: "A",
        description: "",
        modelId: model.id,
        outputDirectory: "relative",
      }),
    ).toThrow(/absolute/);
    expect(() =>
      store.createProject({
        name: "A",
        description: "",
        modelId: "missing",
        outputDirectory: "/does-not-exist",
      }),
    ).toThrow(/model/);
    expect(store.listProjects()).toHaveLength(0);
  });
  it("retains settings through reopening the store", () => {
    const { store, root } = open();
    const settings = {
      ...store.getSettings(),
      language: "en" as const,
      maxTotalTokens: 60000,
    };
    store.saveSettings(settings);
    store.close();
    stores.pop();
    const reopened = new StudioStore(root);
    stores.push(reopened);
    expect(reopened.getSettings()).toEqual(settings);
  });
  it("migrates an existing model table without rewriting existing entries", () => {
    const root = mkdtempSync(join(tmpdir(), "reall-legacy-"));
    roots.push(root);
    const db = new DatabaseSync(join(root, "studio.db"));
    db.exec(
      "CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, base_url TEXT, api_key_enc TEXT, created_at TEXT NOT NULL); INSERT INTO models VALUES ('old', 'Keep me', 'ollama', 'custom-local', NULL, NULL, '2026-01-01');",
    );
    db.close();
    const store = new StudioStore(root);
    stores.push(store);
    expect(store.getModel("old")).toMatchObject({
      id: "old",
      name: "Keep me",
      model: "custom-local",
    });
    expect(store.getModelConfig("old")?.model).toBe("custom-local");
  });
});
describe("per-call pricing", () => {
  it("accounts for cached input without charging it twice", () => {
    const p = presetFor("openai", "gpt-5-mini")!.pricing;
    expect(estimateTokenCost(p, 1_000_000, 500_000, 400_000)).toBeCloseTo(1.16);
  });
  it("applies Gemini's long-context input and output rates on each call", () => {
    const p = presetFor("google", "gemini-2.5-pro")!.pricing;
    expect(estimateTokenCost(p, 200_000, 1000)).toBeCloseTo(0.26);
    expect(estimateTokenCost(p, 200_001, 1000)).toBeCloseTo(0.5150025);
  });
  it("distinguishes unknown rates from a free local API", () => {
    expect(estimateTokenCost(undefined, 1000, 500)).toBeUndefined();
    expect(
      estimateTokenCost(
        presetFor("ollama", "qwen3-coder:30b")!.pricing,
        1000,
        500,
      ),
    ).toBe(0);
    expect(presetFor("openrouter", "openai/gpt-5")?.pricing).toBeUndefined();
  });
  it("does not borrow direct API rates for a custom endpoint", () => {
    const { store } = open();
    const model = store.createModel({
      name: "Custom",
      provider: "openai",
      model: "gpt-5-mini",
      baseURL: "https://example.test/v1",
    });
    expect(model.pricing).toBeUndefined();
  });
});
