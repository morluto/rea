import { expect, it } from "vitest";
import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import {
  environmentCard,
  environmentToolDefinitions,
} from "../../application/environment/environmentTools.js";
import { serveEnvironment } from "./serveEnvironment.js";

const reportedCatalogLimit = (): number => {
  const source = environmentServeSource();
  const result = environmentToolDefinitions(
    source,
    "x".repeat(2 * 1024 * 1024),
  );
  if (result.ok) throw new Error("Expected catalog capacity refusal");
  const limit = result.error.reportedLimits?.max_catalog_bytes;
  if (typeof limit !== "number" || limit <= 0)
    throw new Error("Expected a positive catalog limit");
  return limit;
};

it("refuses a complete oversized discovery before trying to bind", async () => {
  const source = environmentServeSource();
  const tool = source.manifest.tools[0]!;
  const manifest = {
    ...source.manifest,
    tools: [
      {
        ...tool,
        query_parameter_names: Array.from(
          { length: 10000 },
          (_, index) => `q_${index}`,
        ),
      },
    ],
  };
  const result = await serveEnvironment({
    source: { ...source, manifest },
    host: "invalid.rea.invalid",
    port: 0,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      resource: "capacity",
      retryable: false,
      reportedLimits: { max_catalog_bytes: expect.any(Number) },
    },
  });
});

it("refuses a catalog whose individually admissible tools exceed the shared budget", () => {
  const source = environmentServeSource();
  const tools = Array.from({ length: 1000 }, (_, index) => ({
    ...source.manifest.tools[0]!,
    name: `tool_${index}`,
    params: [],
    query_parameter_names: [],
  }));
  const admit = (tools: typeof source.manifest.tools) =>
    environmentToolDefinitions(
      { ...source, manifest: { ...source.manifest, tools } },
      source.manifest.name,
    );
  expect(admit(tools.slice(0, 1)).ok).toBe(true);
  expect(admit(tools)).toMatchObject({
    ok: false,
    error: { resource: "capacity" },
  });
});

it("keeps escaped names within the card budget and reserves state-only fields", () => {
  const source = environmentServeSource();
  const limit = reportedCatalogLimit();
  const empty = { ...source, manifest: { ...source.manifest, tools: [] } };
  const unit = "\u0001";
  const cardBytes = (name: string, mode: "none" | "state") =>
    Buffer.byteLength(JSON.stringify(environmentCard(name, [], mode)));
  const escapedBytes = cardBytes(unit, "none") - cardBytes("", "none");
  const fits = (name: string, dataPlane: "none" | "state") =>
    environmentToolDefinitions(empty, name, { dataPlane }).ok;
  const maxName = (mode: "none" | "state") =>
    unit.repeat(Math.floor((limit - cardBytes("", mode) - 2) / escapedBytes));
  const replayName = maxName("none");
  expect(fits("x".repeat(replayName.length + 1), "none")).toBe(false);
  expect(cardBytes(replayName, "state")).toBeGreaterThan(limit);
  expect(fits(replayName, "state")).toBe(false);
  for (const mode of ["none", "state"] as const) {
    const name = maxName(mode);
    expect(fits(name, mode)).toBe(true);
    expect(cardBytes(name, mode)).toBeLessThanOrEqual(limit);
    expect(fits(`${name}${unit}`, mode)).toBe(false);
  }
});
