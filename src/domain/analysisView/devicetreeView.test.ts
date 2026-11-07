import { expect, it } from "vitest";

import { createEvidence } from "../evidence.js";
import type { Devicetree } from "../firmware/devicetree.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
  type AnalysisViewRequest,
} from "./analysisView.js";

const report: Devicetree = {
  artifact: {
    path: "/artifacts/board.dtb",
    sha256: "a".repeat(64),
    bytes: 512,
  },
  header: {
    magic: 0xd00dfeed,
    totalsize: 512,
    off_dt_struct: 48,
    off_dt_strings: 256,
    off_mem_rsvmap: 16,
    version: 17,
    last_comp_version: 16,
    boot_cpuid_phys: 0,
    size_dt_strings: 32,
    size_dt_struct: 208,
  },
  reservations: [{ offset: 16, address: "0x80000000", size: "0x1000" }],
  nodes: [
    {
      path: "/",
      parent: null,
      offset: 48,
      properties: [
        {
          name: "compatible",
          offset: 64,
          bytes: 11,
          hex: "746573742c626f61726400",
          truncated: false,
          derived: {
            confidence: "derived",
            strings: ["test,board"],
            cells: null,
            reg: null,
          },
        },
      ],
    },
    {
      path: "/soc",
      parent: "/",
      offset: 96,
      properties: [
        {
          name: "ranges",
          offset: 112,
          bytes: 0,
          hex: "",
          truncated: false,
          derived: {
            confidence: "derived",
            strings: null,
            cells: [],
            reg: null,
          },
        },
      ],
    },
  ],
  references: [
    {
      source: "/soc/serial@1000",
      property: "interrupt-parent",
      phandle: 1,
      target: "/soc/interrupt-controller@2000",
      confidence: "derived",
    },
    {
      source: "/soc/other",
      property: "clocks",
      phandle: 2,
      target: null,
      confidence: "derived",
    },
  ],
  summary: {
    confidence: "derived",
    compatible: ["test,board"],
    model: "Test board",
    bootargs: "console=ttyS0",
    stdout_path: null,
    aliases: [{ name: "serial0", path: "/soc/serial@1000" }],
  },
  coverage: {
    status: "complete",
    examined_nodes: 2,
    examined_properties: 2,
  },
  limitations: [],
};

const parent = (value = structuredClone(report)): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: "file",
    },
    {
      id: "devicetree-parser",
      name: "REA Devicetree parser",
      version: "1",
    },
    {
      operation: "inspect_devicetree",
      parameters: { path: value.artifact.path },
      result: value,
    },
  );
  return {
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    subject: evidence.subject,
    normalizedResult: value,
    limitations: [],
  };
};

it("projects a summary view with counts and unresolved reference calculations", () => {
  const source = parent();
  const result = projectAnalysisView(source, { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_devicetree",
    summary: {
      reservation_count: 1,
      reference_count: 2,
      unresolved_reference_count: 1,
      summary: {
        model: "Test board",
        compatible: ["test,board"],
      },
    },
    coverage: {
      status: "complete-within-view",
      examined: 2,
      total: 2,
    },
  });
  expect(result.value.unknowns).toHaveLength(1);
  expect(typeof result.value.unknowns[0]).toBe("string");
});

it("pages nodes without nested properties and includes property_count and source_index", () => {
  const source = parent();
  const result = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "nodes",
    offset: 0,
    limit: 10,
  });
  if (!result.ok || result.value.kind !== "devicetree")
    throw new Error("Devicetree nodes page failed");
  expect(result.value.items).toEqual([
    {
      path: "/",
      parent: null,
      offset: 48,
      property_count: 1,
      source_index: 0,
    },
    {
      path: "/soc",
      parent: "/",
      offset: 96,
      property_count: 1,
      source_index: 1,
    },
  ]);
  expect(result.value.devicetree).toMatchObject({
    reservation_count: 1,
    reference_count: 2,
    unresolved_reference_count: 1,
    alias_count: 1,
  });
});

it("pages nodes with offset and limit, returning the second page and updating coverage", () => {
  const source = parent();
  const firstPage = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "nodes",
    offset: 0,
    limit: 1,
  });
  if (!firstPage.ok || firstPage.value.kind !== "devicetree")
    throw new Error("First page failed");
  expect(firstPage.value.items).toEqual([
    {
      path: "/",
      parent: null,
      offset: 48,
      property_count: 1,
      source_index: 0,
    },
  ]);
  expect(firstPage.value.coverage).toMatchObject({
    status: "page",
    examined: 1,
    total: 2,
  });

  const secondPage = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "nodes",
    offset: 1,
    limit: 1,
  });
  if (!secondPage.ok || secondPage.value.kind !== "devicetree")
    throw new Error("Second page failed");
  expect(secondPage.value.items).toEqual([
    {
      path: "/soc",
      parent: "/",
      offset: 96,
      property_count: 1,
      source_index: 1,
    },
  ]);
  expect(secondPage.value.coverage).toMatchObject({
    status: "page",
    examined: 1,
    total: 2,
  });
});

it("pages a single node by path while preserving its original index", () => {
  const source = parent();
  const result = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "nodes",
    path: "/soc",
    offset: 0,
    limit: 10,
  });
  if (!result.ok || result.value.kind !== "devicetree")
    throw new Error("Devicetree node by path failed");
  expect(result.value.items).toEqual([
    {
      path: "/soc",
      parent: "/",
      offset: 96,
      property_count: 1,
      source_index: 1,
    },
  ]);
  expect(result.value.coverage.total).toBe(1);
});

it("pages properties of a selected node path", () => {
  const source = parent();
  const result = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "properties",
    path: "/",
    offset: 0,
    limit: 10,
  });
  if (!result.ok || result.value.kind !== "devicetree")
    throw new Error("Devicetree properties page failed");
  expect(result.value.items).toEqual([
    {
      name: "compatible",
      offset: 64,
      bytes: 11,
      hex: "746573742c626f61726400",
      truncated: false,
      derived: {
        confidence: "derived",
        strings: ["test,board"],
        cells: null,
        reg: null,
      },
      source_index: 0,
    },
  ]);
});

it("rejects properties collection without path", () => {
  const source = parent();
  const result = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "properties",
    offset: 0,
    limit: 10,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatchObject({
      operation: "inspect_analysis_view",
      issues: [
        {
          path: ["view"],
          reason: "invalid_value",
        },
      ],
    });
  }
});

it("rejects properties collection when node path is absent", () => {
  const source = parent();
  const result = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "properties",
    path: "/nonexistent",
    offset: 0,
    limit: 10,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatchObject({
      operation: "inspect_analysis_view",
      issues: [
        {
          path: ["view"],
          reason: "invalid_value",
        },
      ],
    });
  }
});

it("pages reservations and references with source_index", () => {
  const source = parent();
  const reservations = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "reservations",
    offset: 0,
    limit: 10,
  });
  if (!reservations.ok || reservations.value.kind !== "devicetree")
    throw new Error("Devicetree reservations failed");
  expect(reservations.value.items).toEqual([
    {
      offset: 16,
      address: "0x80000000",
      size: "0x1000",
      source_index: 0,
    },
  ]);

  const references = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "references",
    offset: 0,
    limit: 10,
  });
  if (!references.ok || references.value.kind !== "devicetree")
    throw new Error("Devicetree references failed");
  expect(references.value.items).toHaveLength(2);
  expect(references.value.items[0]).toMatchObject({
    source: "/soc/serial@1000",
    source_index: 0,
  });
  expect(references.value.items[1]).toMatchObject({
    source: "/soc/other",
    source_index: 1,
  });
});

it("rejects path on collections that do not support it", () => {
  const source = parent();
  const result = projectAnalysisView(source, {
    kind: "devicetree",
    collection: "reservations",
    path: "/",
    offset: 0,
    limit: 10,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatchObject({
      operation: "inspect_analysis_view",
      issues: [
        {
          path: ["view"],
          reason: "invalid_value",
        },
      ],
    });
  }
});

it("rejects unsupported view kinds with an input error", () => {
  const source = parent();
  const invalid = projectAnalysisView(source, {
    kind: "cve",
  } as unknown as AnalysisViewRequest);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) {
    expect(invalid.error).toMatchObject({
      operation: "inspect_analysis_view",
      issues: [
        {
          path: ["view"],
          reason: "invalid_value",
        },
      ],
    });
  }
});
