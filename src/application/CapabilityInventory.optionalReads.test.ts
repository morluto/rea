import { expect, it } from "vitest";
import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import { createAnalysisExecution } from "./AnalysisProvider.js";
import { buildCapabilityInventory } from "./CapabilityInventory.js";
import { EnhancedTools } from "./EnhancedTools.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const inventory = (
  operations: readonly string[],
  effectSource: string,
  missing?: string,
) =>
  buildCapabilityInventory(
    {
      open: true,
      kind: "executable",
      capabilities: [
        {
          provider,
          shared_limitations: [],
          groups: operations
            .filter((operation) => operation !== missing)
            .map((operation) => ({
              operations: [operation],
              effects:
                operation === effectSource
                  ? ["launches_process", "may_write_filesystem"]
                  : [],
              limitations: [],
              available: true,
              reason: null,
              availability_code: null,
            })),
        },
      ],
    },
    { processCaptureEnabled: false },
  );

it.each([
  {
    tool: "batch_decompile",
    optional: "address_name",
    required: "procedure_pseudo_code",
    input: { addresses: ["entry"] },
  },
  {
    tool: "get_objc_classes",
    optional: "inspect_native_dispatch_metadata",
    required: "list_names",
    input: {},
  },
  {
    tool: "analyze_swift_types",
    optional: "list_names",
    required: "list_procedures",
    input: {},
  },
  {
    tool: "trace_feature",
    optional: "resolve_containing_procedure",
    required: "search_strings",
    input: { query: "needle" },
  },
  {
    tool: "binary_overview",
    optional: "list_segments",
    required: "current_document",
    input: {},
  },
] as const)(
  "reports the effects of $tool's dispatched optional $optional read without requiring it for readiness",
  async ({ tool, optional, required, input }) => {
    const calls: string[] = [];
    const tools = new EnhancedTools({
      execute: async (operation) => {
        calls.push(operation);
        if (
          operation === "read_binary_inventory_summary" ||
          operation === "inspect_native_dispatch_metadata"
        )
          return err(
            new AnalysisCapabilityUnavailableError(
              provider.id,
              operation,
              "fixture does not provide this representation",
            ),
          );
        let value: JsonValue = [];
        if (operation === "current_document") value = "fixture";
        else if (operation === "procedure_address") value = "0x1000";
        else if (operation === "address_name") value = "entry";
        else if (operation === "procedure_pseudo_code") value = "code";
        else if (operation === "list_names" && tool === "get_objc_classes")
          value = [{ address: "0x1000", value: "OBJC_CLASS_$_Example" }];
        else if (operation === "search_strings")
          value = [{ address: "0x2000", value: "needle" }];
        else if (operation === "xrefs") value = ["0x1000"];
        else if (operation === "resolve_containing_procedure")
          value = {
            query_address: "0x1000",
            found: false,
            procedure: null,
            reason: "not_in_procedure",
          };
        return ok(createAnalysisExecution(value, provider));
      },
    });
    const result = await tools.execute(tool, input);
    expect(result.ok).toBe(true);
    expect(calls).toContain(optional);
    const operations = [...new Set(calls)].filter(
      (operation) => operation !== "read_binary_inventory_summary",
    );
    const selected = (missing?: string) =>
      inventory(operations, optional, missing).find((row) => row.name === tool);
    expect(selected()).toMatchObject({
      available: true,
      effects: { launchesProcess: true, writesFilesystem: true },
    });
    expect(selected(optional)).toMatchObject({
      available: true,
      effects: { launchesProcess: false, writesFilesystem: false },
    });
    expect(selected(required)).toMatchObject({ available: false });
    if (tool !== "batch_decompile")
      expect(selected(required)).toMatchObject({
        effects: { launchesProcess: false, writesFilesystem: false },
      });
  },
);

it("reports the effectful direct overview read even when fallback inventories are unavailable", async () => {
  const calls: string[] = [];
  const result = await new EnhancedTools({
    execute: async (operation) => {
      calls.push(operation);
      return ok(
        createAnalysisExecution(
          { document: "fixture", procedure_count: 0, string_count: 0 },
          provider,
        ),
      );
    },
  }).execute("binary_overview", {});
  expect(result.ok).toBe(true);
  expect(calls).toEqual(["read_binary_inventory_summary"]);
  expect(
    inventory(calls, calls[0]!).find((row) => row.name === "binary_overview"),
  ).toMatchObject({
    available: true,
    effects: { launchesProcess: true, writesFilesystem: true },
  });
});

it("reports parallel overview string-read effects after its sibling inventory is unavailable", async () => {
  const calls: string[] = [];
  const failure = new AnalysisCapabilityUnavailableError(
    provider.id,
    "list_procedures",
    "fixture procedure inventory unavailable",
  );
  const result = await new EnhancedTools({
    execute: async (operation) => {
      calls.push(operation);
      if (
        operation === "read_binary_inventory_summary" ||
        operation === "list_procedures"
      )
        return err(failure);
      return ok(
        createAnalysisExecution(
          operation === "current_document" ? "fixture" : [],
          provider,
        ),
      );
    },
  }).execute("binary_overview", {});
  expect(result).toEqual(err(failure));
  expect(calls).toContain("list_strings");
  expect(
    inventory(
      calls.filter(
        (operation) => operation !== "read_binary_inventory_summary",
      ),
      "list_strings",
      "list_procedures",
    ).find((row) => row.name === "binary_overview"),
  ).toMatchObject({
    available: false,
    effects: { launchesProcess: true, writesFilesystem: true },
  });
});

it("includes fallback effects when an advertised available aggregate read declines the request", async () => {
  const calls: string[] = [];
  const result = await new EnhancedTools({
    execute: async (operation) => {
      calls.push(operation);
      if (operation === "read_binary_inventory_summary")
        return err(
          new AnalysisCapabilityUnavailableError(
            provider.id,
            operation,
            "aggregate cannot represent this request",
          ),
        );
      return ok(
        createAnalysisExecution(
          operation === "current_document" ? "fixture" : [],
          provider,
        ),
      );
    },
  }).execute("binary_overview", {});
  expect(result.ok).toBe(true);
  expect(calls[0]).toBe("read_binary_inventory_summary");
  expect(calls).toContain("list_strings");
  // Every descriptor, including the aggregate, advertises availability.
  expect(
    inventory(calls, "list_strings").find(
      (row) => row.name === "binary_overview",
    ),
  ).toMatchObject({
    available: true,
    effects: { launchesProcess: true, writesFilesystem: true },
  });
});
