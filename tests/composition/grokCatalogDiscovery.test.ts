import { expect, it } from "vitest";
import { GrokCatalogDiscovery } from "../../scripts/verify/clients/grok-catalog.mjs";

const tool = (name: string) => ({
  tool_name: name,
  input_schema: { type: "object", properties: {} },
});
const page = (names: readonly string[]) => ({
  status: "ready",
  results: [{ server: "rea", tools: names.map(tool) }],
});

it("covers a catalog larger than uint8 with only missing-name follow-ups", () => {
  const names = Array.from({ length: 258 }, (_, index) => `rea__tool_${index}`);
  const discovery = new GrokCatalogDiscovery(names);
  let query = discovery.accept(page(names.slice(0, 255)), "rea");
  expect(query).toBe(names[255]);
  expect(discovery.size).toBe(255);
  for (const name of names.slice(255)) {
    expect(query).toBe(name);
    query = discovery.accept(page([names[0]!, name]), name);
  }
  expect(query).toBeUndefined();
  expect(discovery.size).toBe(names.length);
  expect(discovery.pages).toHaveLength(4);
});

it("accepts a complete small catalog in a single query", () => {
  const discovery = new GrokCatalogDiscovery(["rea__one"]);
  expect(discovery.accept(page(["rea__one"]), "rea")).toBeUndefined();
  expect(discovery.size).toBe(1);
});

it("fails closed when a targeted native search does not return its missing tool", () => {
  const discovery = new GrokCatalogDiscovery(["rea__one", "rea__two"]);
  expect(discovery.accept(page(["rea__one"]), "rea")).toBe("rea__two");
  expect(() => discovery.accept(page(["rea__one"]), "rea__two")).toThrow(
    "requested missing tool",
  );
  expect(discovery.size).toBe(1);
});

it("does not count foreign server tools toward REA coverage", () => {
  const discovery = new GrokCatalogDiscovery(["rea__one"]);
  expect(
    discovery.accept(
      {
        status: "ready",
        results: [{ server: "foreign", tools: [tool("rea__one")] }],
      },
      "rea",
    ),
  ).toBe("rea__one");
  expect(discovery.size).toBe(0);
});

it.each([
  { value: tool("rea__unknown"), reason: "Unexpected REA tool" },
  { value: { tool_name: "rea__one" }, reason: "missing input schema" },
  {
    value: { tool_name: "rea__one", input_schema: { type: "invalid" } },
    reason: "invalid advertised schema",
  },
])("rejects $reason", ({ value, reason }) => {
  const discovery = new GrokCatalogDiscovery(["rea__one"]);
  expect(() =>
    discovery.accept(
      { status: "ready", results: [{ server: "rea", tools: [value] }] },
      "rea",
    ),
  ).toThrow(reason);
  expect(discovery.size).toBe(0);
});
