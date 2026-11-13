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
  expect(manifest.tools[0]?.query_parameter_names).toHaveLength(10000);
});

it("charges environment identity, aggregate tools and escaped text before producing a card", () => {
  const source = environmentServeSource();
  const limit = reportedCatalogLimit();
  const tools = Array.from({ length: 1000 }, (_, index) => ({
    ...source.manifest.tools[0]!,
    name: `tool_${index}`,
    params: [],
    query_parameter_names: [],
  }));
  expect(
    environmentToolDefinitions(
      {
        ...source,
        manifest: { ...source.manifest, tools },
      },
      source.manifest.name,
    ).ok,
  ).toBe(false);
  expect(environmentToolDefinitions(source, "x".repeat(limit)).ok).toBe(false);
  const normal = environmentToolDefinitions(source, source.manifest.name);
  if (!normal.ok) throw normal.error;
  expect(
    Buffer.byteLength(
      JSON.stringify(
        normal.value.map(({ tool: _, ...definition }) => definition),
      ),
    ),
  ).toBeLessThan(limit);
});

it("reserves the state card only when the state data plane is served", () => {
  const source = environmentServeSource();
  const limit = reportedCatalogLimit();
  const empty = { ...source, manifest: { ...source.manifest, tools: [] } };
  const admits = (length: number, dataPlane: "none" | "state") =>
    environmentToolDefinitions(empty, "x".repeat(length), { dataPlane }).ok;
  // With no tools, the name and the card are the whole reservation: six bytes per name unit plus quotes.
  const longest = (dataPlane: "none" | "state") =>
    Math.floor(
      (limit - 2 - JSON.stringify(environmentCard("", [], dataPlane)).length) /
        6,
    );
  const stateless = longest("none");
  expect(admits(stateless, "none")).toBe(true);
  expect(admits(stateless + 1, "none")).toBe(false);
  expect(longest("state")).toBeLessThan(stateless);
  expect(admits(stateless, "state")).toBe(false);
  expect(admits(longest("state"), "state")).toBe(true);
  expect(admits(longest("state") + 1, "state")).toBe(false);
});
