import { expect, it } from "vitest";
import { SqliteDatabaseService } from "./SqliteDatabaseService.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { err } from "../../domain/result.js";
import { ok } from "../../domain/result.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";

const fixture = () => ({
  artifact: { path: "/selected.db", sha256: "a".repeat(64), bytes: 4096 },
  wal: null,
  engine: { name: "SQLite", version: "3.50.2" },
  database_encoding: "UTF-8",
  schema: {
    completeness: "complete",
    tables: [],
    indexes: [],
    views: [],
    triggers: [],
  },
  rows: null,
  limitations: [],
});

const execution = (value: unknown) =>
  createAnalysisExecution(
    value,
    { id: "sqlite", name: "SQLite", version: "3.50.2" },
    {
      subject: { path: "/selected.db", sha256: "a".repeat(64), format: "file" },
      locations: [{ kind: "artifact-path", path: "/selected.db" }],
    },
  );

it.each([
  { path: "relative.db" },
  { path: "/selected.db", approval: true },
  { path: "/selected.db", row_limit: 1 },
  { path: "/selected.db", table: 1 },
  { path: "/selected.db", table: "data", row_limit: 0 },
  {
    path: "/selected.db",
    table: "data",
    row_limit: Number.MAX_SAFE_INTEGER + 1,
  },
])(
  "rejects invalid SQLite selection before provider effects: %j",
  async (input) => {
    const service = new SqliteDatabaseService({
      inspect: () => {
        throw new Error("Invalid selection must not read a database");
      },
    });
    expect(await service.inspect(input)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  },
);

it("preserves producer failures and rejects pre-cancelled requests before effects", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "rea-sqlite",
    "inspect_sqlite_database",
    "Selected worker could not start",
  );
  const service = new SqliteDatabaseService({
    inspect: () => Promise.resolve(err(failure)),
  });
  expect(await service.inspect({ path: "/selected.db" })).toEqual(err(failure));
  const signal = AbortSignal.abort();
  const untouched = new SqliteDatabaseService({
    inspect: () => {
      throw new Error("Cancelled selection must not read a database");
    },
  });
  expect(
    await untouched.inspect({ path: "/selected.db" }, { signal }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it.each(["path", "digest", "subject", "wal", "table"])(
  "rejects producer results with changed caller binding: %s",
  async (problem) => {
    const value = fixture();
    if (problem === "path") value.artifact.path = "/other.db";
    if (problem === "digest") value.artifact.sha256 = "b".repeat(64);
    const observed = execution({
      ...value,
      ...(problem === "wal"
        ? { wal: { path: "/other.db-wal", sha256: "b".repeat(64), bytes: 32 } }
        : {}),
    });
    const service = new SqliteDatabaseService({
      inspect: () =>
        Promise.resolve(
          ok({
            ...observed,
            ...(problem === "subject" ? { subject: null } : {}),
          }),
        ),
    });
    expect(
      await service.inspect({
        path: "/selected.db",
        ...(problem === "table" ? { table: "selected" } : {}),
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  },
);

it("returns observed inline evidence only while the request remains active", async () => {
  const value = fixture();
  const service = new SqliteDatabaseService({
    inspect: () => Promise.resolve(ok(execution(value))),
  });
  expect(await service.inspect({ path: "/selected.db" })).toMatchObject({
    ok: true,
    value: {
      confidence: "observed",
      subject: {
        local_path: "/selected.db",
        digest: { sha256: "a".repeat(64) },
      },
      normalized_result: value,
    },
  });
  const controller = new AbortController();
  const cancelled = new SqliteDatabaseService({
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(execution(value)));
    },
  });
  expect(
    await cancelled.inspect(
      { path: "/selected.db" },
      { signal: controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});
