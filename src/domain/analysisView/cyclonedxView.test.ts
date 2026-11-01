import { expect, it } from "vitest";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import { createEvidence } from "../evidence.js";
import {
  goBinarySchema,
  type GoBinary,
  type GoModule,
} from "../go/goBinary.js";
import { rustBinarySchema, type RustBinary } from "../rust/rustBinary.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";
import { goBinaryUnknowns } from "./goBinaryView.js";
import { rustBinaryUnknowns } from "./rustBinaryView.js";
import {
  CYCLONEDX_DOCUMENT_BYTE_LIMIT,
  cycloneDxSerialNumber,
} from "./cyclonedxView.js";

const SHA = "a".repeat(64);
const VIEW = { kind: "cyclonedx" } as const;
const VERSION = Buffer.from("go1.22.0");
const MODULE_TEXT = Buffer.from("module");

const parentFor = (operation: string, report: unknown): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: "/artifacts/program",
      sha256: SHA,
      format: "elf",
      architecture: "x86_64",
    },
    { id: "cyclonedx-test", name: "CycloneDX test", version: "1" },
    {
      operation,
      parameters: { path: "/artifacts/program" },
      result: report,
      confidence: "observed",
    },
  );
  return {
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    subject: evidence.subject,
    normalizedResult: structuredClone(report),
    limitations: evidence.limitations,
  };
};

const goModule = (
  path: string,
  version: string,
  sum: string | null = null,
  replacement: GoModule["replacement"] = null,
): GoModule => ({ path, version, sum, replacement });

const goReport = (
  module: NonNullable<GoBinary["build_info"]>["module"] | null,
): GoBinary =>
  goBinarySchema.parse({
    artifact: { path: "/artifacts/program", sha256: SHA, bytes: 256 },
    format: "elf",
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    limitations: ["go reader note"],
    build_info:
      module === null
        ? null
        : {
            header_offset: 0,
            encoding: "inline",
            go_version: "go1.22.0",
            go_version_bytes_base64: VERSION.toString("base64"),
            module_text: "module",
            module_bytes_base64: MODULE_TEXT.toString("base64"),
            version_location: { offset: 32, bytes: VERSION.length },
            module_location: { offset: 48, bytes: MODULE_TEXT.length },
            module,
          },
  });

const projectGo = (report: GoBinary) => {
  const result = projectAnalysisView(
    parentFor("inspect_go_binary", report),
    VIEW,
  );
  if (!result.ok) throw result.error;
  if (result.value.kind !== "cyclonedx")
    throw new Error("Expected a CycloneDX view");
  return result.value;
};

const rustMetadata = (
  packages: NonNullable<RustBinary["auditable_metadata"]>["packages"],
  edges: NonNullable<RustBinary["auditable_metadata"]>["dependency_edges"],
  cycles: number[],
  root: number | null,
) =>
  rustBinarySchema.parse({
    artifact: { path: "/artifacts/rustapp", sha256: SHA, bytes: 512 },
    format: "elf",
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    limitations: [],
    rustc_commit: null,
    auditable_metadata: {
      section_name: ".dep-v0",
      file_offset: 32,
      section_bytes: 64,
      compressed_bytes: 64,
      uncompressed_bytes: 128,
      format_version: 1,
      packages,
      root_package_index: root,
      dependency_edges: edges,
      cyclic_dependency_indices: cycles,
    },
  });

const projectRust = (report: RustBinary) => {
  const result = projectAnalysisView(
    parentFor("inspect_rust_binary", report),
    VIEW,
  );
  if (!result.ok) throw result.error;
  if (result.value.kind !== "cyclonedx")
    throw new Error("Expected a CycloneDX view");
  return result.value;
};

it("derives a stable version-8 serial number from the parent digest", () => {
  const serial = cycloneDxSerialNumber(SHA);
  expect(serial).toBe(cycloneDxSerialNumber(SHA));
  expect(serial).toMatch(
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

it("projects Go modules with Package URLs, replacements and main-module edges", () => {
  const report = goReport({
    path: "example.com/tool/cmd/tool",
    main: goModule("example.com/tool", "(devel)"),
    dependencies: [
      goModule(
        "github.com/Azure/go-autorest",
        "v0.11.29",
        "h1:not-a-file-hash",
      ),
      goModule("example.com/legacy", "v2.0.0+incompatible", "h1:original", {
        path: "example.com/fork",
        version: "v1.2.3",
        sum: "h1:replacement",
      }),
      goModule("example.com/empty", ""),
    ],
    settings: [],
    unparsed_lines: [],
    unparsed_line_bytes_base64: [],
    complete: true,
  });
  const view = projectGo(report);
  const again = projectGo(report);
  expect(JSON.stringify(view.document)).toBe(JSON.stringify(again.document));
  expect(view.view_digest).toBe(again.view_digest);
  expect(view.document).not.toHaveProperty("timestamp");
  expect(view.document.metadata.component).toMatchObject({
    type: "file",
    name: "program",
    hashes: [{ alg: "SHA-256", content: SHA }],
  });
  expect(view.document.components.map((component) => component.purl)).toEqual([
    "pkg:golang/example.com/tool@%28devel%29",
    "pkg:golang/github.com/azure/go-autorest@v0.11.29",
    "pkg:golang/example.com/fork@v1.2.3",
    "pkg:golang/example.com/empty",
  ]);
  expect(
    view.document.components.every(
      (component) => component.hashes === undefined,
    ),
  ).toBe(true);
  expect(view.document.components[1]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:not-a-file-hash" },
  ]);
  expect(view.document.components[2]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:replacement" },
    {
      name: "rea:go:original",
      value: "pkg:golang/example.com/legacy@v2.0.0%2Bincompatible",
    },
    { name: "rea:go:original-sum", value: "h1:original" },
  ]);
  expect(view.document.dependencies).toEqual([
    {
      ref: "pkg:golang/example.com/tool@%28devel%29",
      dependsOn: [
        "pkg:golang/github.com/azure/go-autorest@v0.11.29",
        "pkg:golang/example.com/fork@v1.2.3",
        "pkg:golang/example.com/empty",
      ],
    },
  ]);
  expect(view.document.compositions).toEqual([
    {
      aggregate: "unknown",
      assemblies: [`sha256:${SHA}`],
      dependencies: view.document.components.map(
        (component) => component["bom-ref"],
      ),
    },
  ]);
  expect(view.source_coverage).toEqual({
    aggregate: "unknown",
    records: "present",
  });
  expect(view.document.properties).toEqual(
    expect.arrayContaining([
      { name: "rea:evidence_id", value: view.parent_evidence_id },
      { name: "rea:go:graph", value: "main-module-edges" },
    ]),
  );
  expect(view.limitations.join(" ")).toContain("no module graph");
  expect(view.limitations.join(" ")).toContain("does not establish");
  expect(JSON.stringify(view.document)).not.toContain('"complete"');
});

it("marks partial Go module coverage incomplete and absent build info unknown", () => {
  const partial = projectGo(
    goReport({
      path: "example.com/tool",
      main: null,
      dependencies: [goModule("example.com/dep", "v1.0.0")],
      settings: [],
      unparsed_lines: ["?"],
      unparsed_line_bytes_base64: [],
      complete: false,
    }),
  );
  expect(partial.source_coverage).toEqual({
    aggregate: "incomplete",
    records: "partial",
  });
  expect(partial.document.compositions[0]?.aggregate).toBe("incomplete");
  expect(partial.document.dependencies).toBeUndefined();
  expect(partial.unknowns.join(" ")).toContain("not parsed");

  const absentReport = goReport(null);
  const absent = projectGo(absentReport);
  expect(absent.unknowns).toEqual(
    expect.arrayContaining([...goBinaryUnknowns(absentReport).values]),
  );
  expect(absent.source_coverage).toEqual({
    aggregate: "unknown",
    records: "absent",
  });
  expect(absent.document.components).toEqual([]);
  expect(absent.document.dependencies).toBeUndefined();
  expect(absent.document.compositions[0]).toEqual({
    aggregate: "unknown",
    assemblies: [`sha256:${SHA}`],
  });
});

it("does not report an embedded list for parse-complete GOPATH metadata", () => {
  const view = projectGo(
    goReport({
      path: "example.com/tool",
      main: null,
      dependencies: [],
      settings: [{ key: "GOOS", value: "linux" }],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    }),
  );
  expect(view.source_coverage).toEqual({
    aggregate: "unknown",
    records: "absent",
  });
  expect(view.document.components).toEqual([]);
  expect(view.document.dependencies).toBeUndefined();
  expect(view.document.compositions[0]?.aggregate).toBe("unknown");
  expect(view.unknowns.join(" ")).toContain("No main module was decoded");
});

it("omits an unparsed Go dependency list instead of claiming it is empty", () => {
  const incomplete = projectGo(
    goReport({
      path: "example.com/tool",
      main: goModule("example.com/tool", "v1.2.3"),
      dependencies: [],
      settings: [],
      unparsed_lines: ["dep\tbroken"],
      unparsed_line_bytes_base64: [],
      complete: false,
    }),
  );
  expect(incomplete.source_coverage).toEqual({
    aggregate: "incomplete",
    records: "partial",
  });
  expect(incomplete.document.dependencies).toBeUndefined();
  expect(
    incomplete.document.components.map((component) => component.purl),
  ).toEqual(["pkg:golang/example.com/tool@v1.2.3"]);

  const observedEmpty = projectGo(
    goReport({
      path: "example.com/tool",
      main: goModule("example.com/tool", "v1.2.3"),
      dependencies: [],
      settings: [],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    }),
  );
  expect(observedEmpty.source_coverage).toEqual({
    aggregate: "unknown",
    records: "present",
  });
  expect(observedEmpty.document.dependencies).toEqual([
    { ref: "pkg:golang/example.com/tool@v1.2.3", dependsOn: [] },
  ]);

  const parsedWithGap = projectGo(
    goReport({
      path: "example.com/tool",
      main: goModule("example.com/tool", "v1.2.3"),
      dependencies: [goModule("example.com/dep", "v1.0.0")],
      settings: [],
      unparsed_lines: ["dep\tbroken"],
      unparsed_line_bytes_base64: [],
      complete: false,
    }),
  );
  expect(parsedWithGap.document.dependencies).toEqual([
    {
      ref: "pkg:golang/example.com/tool@v1.2.3",
      dependsOn: ["pkg:golang/example.com/dep@v1.0.0"],
    },
  ]);
});

it("refuses a CycloneDX version the specification cannot carry", () => {
  const result = projectAnalysisView(
    parentFor(
      "inspect_go_binary",
      goReport({
        path: "example.com/tool",
        main: goModule("example.com/tool", "v".repeat(1025)),
        dependencies: [],
        settings: [],
        unparsed_lines: [],
        unparsed_line_bytes_base64: [],
        complete: true,
      }),
    ),
    VIEW,
  );
  expect(result.ok).toBe(false);
  if (result.ok || !(result.error instanceof AnalysisInputError))
    throw new Error("Expected a representation refusal");
  expect(result.error.issues[0]?.message).toContain("1024");
});

it("refuses a CycloneDX document past the fixed byte allowance", () => {
  const path = `example.com/${"m".repeat(120)}`;
  const dependencies = Array.from({ length: 1800 }, (_, index) =>
    goModule(`${path}/m${String(index)}`, "v1.0.0", "h1:sum"),
  );
  const result = projectAnalysisView(
    parentFor(
      "inspect_go_binary",
      goReport({
        path: "example.com/tool",
        main: goModule("example.com/tool", "v0.0.0"),
        dependencies,
        settings: [],
        unparsed_lines: [],
        unparsed_line_bytes_base64: [],
        complete: true,
      }),
    ),
    VIEW,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the document allowance");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.message).toContain("export_evidence_bundle");
  expect(result.error.message).toContain(String(CYCLONEDX_DOCUMENT_BYTE_LIMIT));
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw result.error;
  expect(result.error.fixedAllowance).toEqual({
    name: "The CycloneDX document allowance",
    kind: "bytes",
  });
  expect(result.error.retryable).toBe(false);
});

it("refuses a dense Rust graph before expanding its edges", () => {
  const count = 300;
  const indices = Array.from({ length: count }, (_, index) => index);
  const name = "n".repeat(4_000);
  const result = projectAnalysisView(
    parentFor(
      "inspect_rust_binary",
      rustMetadata(
        indices.map((index) => ({
          name: `${name}${String(index)}`,
          version: "1.0.0",
          source: "crates.io",
          kind: "runtime" as const,
          dependencies: indices.slice(0, index),
          features: null,
          root: index === count - 1,
        })),
        indices.flatMap((from_index) =>
          indices
            .slice(0, from_index)
            .map((to_index) => ({ from_index, to_index })),
        ),
        [],
        count - 1,
      ),
    ),
    VIEW,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the document allowance");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.message).toContain("at least");
  expect(result.error.message).toContain("export_evidence_bundle");
});

it("projects Rust edges, build scope and duplicate Package URLs", () => {
  const report = rustMetadata(
    [
      {
        name: "serde",
        version: "1.0.210",
        source: "crates.io",
        kind: "runtime",
        dependencies: [],
        features: null,
        root: false,
      },
      {
        name: "build_helper",
        version: "0.1.0",
        source: "local",
        kind: "build",
        dependencies: [1],
        features: null,
        root: false,
      },
      {
        name: "app",
        version: "0.1.0",
        source: "local",
        kind: null,
        dependencies: [0, 1],
        features: null,
        root: true,
      },
      {
        name: "serde",
        version: "1.0.210",
        source: "crates.io",
        kind: "runtime",
        dependencies: [],
        features: null,
        root: false,
      },
    ],
    [
      { from_index: 1, to_index: 1 },
      { from_index: 2, to_index: 0 },
      { from_index: 2, to_index: 1 },
    ],
    [1],
    2,
  );
  const first = projectRust(report);
  const second = projectRust(report);
  expect(JSON.stringify(first.document)).toBe(JSON.stringify(second.document));
  expect(first.view_digest).toBe(second.view_digest);
  expect(first.document.components.map((component) => component.scope)).toEqual(
    ["required", "excluded", undefined, "required"],
  );
  const serde = "pkg:cargo/serde@1.0.210";
  expect(
    first.document.components.map((component) => component["bom-ref"]),
  ).toEqual([serde, "rust-package:1", "rust-package:2", `${serde}#1`]);
  expect(first.document.components.map((component) => component.purl)).toEqual([
    serde,
    undefined,
    undefined,
    serde,
  ]);
  expect(first.unknowns).toEqual(
    expect.arrayContaining([
      "Rust package app 0.1.0 from source local has no Package URL because pkg:cargo names a crates.io package.",
    ]),
  );
  expect(first.document.dependencies).toEqual([
    { ref: serde, dependsOn: [] },
    {
      ref: "rust-package:1",
      dependsOn: ["rust-package:1"],
    },
    {
      ref: "rust-package:2",
      dependsOn: [serde, "rust-package:1"],
    },
    { ref: `${serde}#1`, dependsOn: [] },
  ]);
  expect(first.document.components[2]?.properties).toEqual([
    { name: "rea:cargo:source", value: "local" },
    { name: "rea:cargo:kind", value: "omitted" },
  ]);
  expect(first.source_coverage).toEqual({
    aggregate: "unknown",
    records: "present",
  });
  expect(first.document.compositions[0]?.aggregate).toBe("unknown");
  expect(JSON.stringify(first.document)).not.toContain('"complete"');
});

it("keeps missing Rust metadata unknown instead of an empty inventory", () => {
  const report = rustBinarySchema.parse({
    artifact: { path: "/artifacts/rustapp", sha256: SHA, bytes: 512 },
    format: "elf",
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    limitations: [],
    rustc_commit: null,
    auditable_metadata: null,
  });
  const view = projectRust(report);
  expect(view.unknowns).toEqual(
    expect.arrayContaining([...rustBinaryUnknowns(report).values]),
  );
  expect(view.source_coverage).toEqual({
    aggregate: "unknown",
    records: "absent",
  });
  expect(view.document.components).toEqual([]);
  expect(view.document.dependencies).toBeUndefined();
  expect(view.unknowns.join(" ")).toContain("does not establish an empty");
});

it("refuses a CycloneDX view of a parent that is neither Go nor Rust", () => {
  const evidence = createEvidence(
    undefined,
    { id: "layout", name: "Layout", version: "1" },
    {
      operation: "inspect_binary_layout",
      parameters: {},
      result: { artifact: { path: "/artifacts/other" } },
      confidence: "observed",
    },
  );
  const result = projectAnalysisView(
    {
      evidenceId: evidence.evidence_id,
      operation: evidence.operation,
      normalizedResult: evidence.normalized_result,
      limitations: [],
    },
    VIEW,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected an unsupported parent");
  expect(result.error).toBeInstanceOf(AnalysisUnsupportedTargetError);
  expect(result.error.message).toContain(
    "inspect_go_binary or inspect_rust_binary",
  );
});

it("keeps a local Go path unknown and retains a module identity", () => {
  const report = goReport({
    path: "example.com/tool",
    main: goModule("example.com/tool", "(devel)"),
    dependencies: [
      goModule("example.com/dep", "v0.1.0", "h1:original", {
        path: "./dep",
        version: "(devel)",
        sum: "h1:local",
      }),
      goModule("example.com/abs", "v1.0.0", null, {
        path: "/home/alice/dep",
        version: "(devel)",
        sum: null,
      }),
      goModule("example.com/win", "v1.0.0", null, {
        path: "C:/src/dep",
        version: "(devel)",
        sum: null,
      }),
      goModule("example.com/rel", "v1.0.0", null, {
        path: ".\\dep",
        version: "(devel)",
        sum: null,
      }),
      goModule("../dependency", "", "h1:directory"),
      goModule("./local", "v0.0.0", "h1:local-sum", {
        path: "example.com/fork",
        version: "v1.2.3",
        sum: "h1:fork",
      }),
      goModule("example.com/foo.bar", "v1.0.0"),
    ],
    settings: [],
    unparsed_lines: [],
    unparsed_line_bytes_base64: [],
    complete: true,
  });
  const view = projectGo(report);
  const serialized = JSON.stringify(view.document);
  expect(view.document.components.map((component) => component.purl)).toEqual([
    "pkg:golang/example.com/tool@%28devel%29",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "pkg:golang/example.com/fork@v1.2.3",
    "pkg:golang/example.com/foo.bar@v1.0.0",
  ]);
  expect(serialized).not.toContain("pkg:golang/.");
  expect(serialized).not.toContain("pkg:golang//");
  expect(serialized).not.toContain("pkg:golang/C:");
  expect(
    view.document.components.slice(1, 5).map((component) => ({
      name: component.name,
      version: component.version,
      purl: component.purl,
    })),
  ).toEqual([
    { name: "./dep", version: "(devel)", purl: undefined },
    { name: "/home/alice/dep", version: "(devel)", purl: undefined },
    { name: "C:/src/dep", version: "(devel)", purl: undefined },
    { name: ".\\dep", version: "(devel)", purl: undefined },
  ]);
  expect(view.document.components[1]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:local" },
    { name: "rea:go:original", value: "pkg:golang/example.com/dep@v0.1.0" },
    { name: "rea:go:original-sum", value: "h1:original" },
    { name: "rea:go:local-replacement", value: "./dep" },
  ]);
  expect(view.document.components[5]).toMatchObject({
    name: "../dependency",
    "bom-ref": "go-module:5",
  });
  expect(view.document.components[5]).not.toHaveProperty("purl");
  expect(view.document.components[5]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:directory" },
  ]);
  expect(view.document.components[6]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:fork" },
    { name: "rea:go:original", value: "./local" },
    { name: "rea:go:original-sum", value: "h1:local-sum" },
  ]);
  expect(view.unknowns.join("\n")).toContain(
    "Go replacement path ./dep has no module identity.",
  );
  expect(view.unknowns.join("\n")).toContain(
    "Go replacement path /home/alice/dep has no module identity.",
  );
  expect(view.unknowns.join("\n")).toContain(
    "Go replacement path C:/src/dep has no module identity.",
  );
  expect(view.unknowns.join("\n")).toContain(
    "Go replacement path .\\dep has no module identity.",
  );
  expect(view.unknowns.join("\n")).toContain(
    "Go module path ../dependency has no module identity.",
  );
  expect(view.unknowns.join("\n")).toContain(
    "Go module path ./local has no module identity; the replacement module is kept.",
  );
  expect(view.document.dependencies).toEqual([
    {
      ref: "pkg:golang/example.com/tool@%28devel%29",
      dependsOn: [
        "go-module:1",
        "go-module:2",
        "go-module:3",
        "go-module:4",
        "go-module:5",
        "pkg:golang/example.com/fork@v1.2.3",
        "pkg:golang/example.com/foo.bar@v1.0.0",
      ],
    },
  ]);
});

it("keeps an empty Go path unknown and versions a replacement as itself", () => {
  const report = goReport({
    path: "example.com/tool",
    main: goModule("", "v1", "h1:main"),
    dependencies: [
      goModule("", "v1", "h1:dep", {
        path: "./dep",
        version: "(devel)",
        sum: "h1:local-dep",
      }),
      goModule("example.com/kept", "v1.0.0", "h1:kept", {
        path: "",
        version: "v1",
        sum: "h1:replaced",
      }),
      goModule("", "v0.0.0", "h1:empty-original", {
        path: "example.com/fork",
        version: "v1.2.3",
        sum: "h1:fork",
      }),
    ],
    settings: [],
    unparsed_lines: [],
    unparsed_line_bytes_base64: [],
    complete: true,
  });
  const view = projectGo(report);
  const fork = "pkg:golang/example.com/fork@v1.2.3";
  expect(view.document.components.map((component) => component.purl)).toEqual([
    undefined,
    undefined,
    undefined,
    fork,
  ]);
  expect(view.document.components[0]).toMatchObject({
    name: "go-module:0",
    "bom-ref": "go-module:0",
    version: "v1",
  });
  expect(view.document.components[0]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:main" },
  ]);
  expect(view.document.components[0]).not.toHaveProperty("purl");
  expect(view.document.components[1]).toMatchObject({
    name: "./dep",
    "bom-ref": "go-module:1",
    version: "(devel)",
  });
  expect(view.document.components[1]?.properties).toEqual([
    { name: "rea:go:sum", value: "h1:local-dep" },
    { name: "rea:go:original", value: "" },
    { name: "rea:go:original-sum", value: "h1:dep" },
    { name: "rea:go:local-replacement", value: "./dep" },
  ]);
  expect(view.document.components[1]).not.toHaveProperty("purl");
  expect(view.document.components[2]).toMatchObject({
    name: "go-module:2",
    "bom-ref": "go-module:2",
    version: "v1",
    properties: [
      { name: "rea:go:sum", value: "h1:replaced" },
      {
        name: "rea:go:original",
        value: "pkg:golang/example.com/kept@v1.0.0",
      },
      { name: "rea:go:original-sum", value: "h1:kept" },
      { name: "rea:go:local-replacement", value: "" },
    ],
  });
  expect(view.document.components[2]).not.toHaveProperty("purl");
  expect(view.document.components[3]).toMatchObject({
    name: "example.com/fork",
    "bom-ref": fork,
    purl: fork,
    properties: [
      { name: "rea:go:sum", value: "h1:fork" },
      { name: "rea:go:original", value: "" },
      { name: "rea:go:original-sum", value: "h1:empty-original" },
    ],
  });
  expect(JSON.stringify(view.document)).not.toContain("pkg:golang@");
  expect(view.document.dependencies).toEqual([
    {
      ref: "go-module:0",
      dependsOn: ["go-module:1", "go-module:2", fork],
    },
  ]);
  const unknowns = view.unknowns.join("\n");
  expect(unknowns).toContain('Go module path "" has no module identity.');
  expect(unknowns).toContain('Go replacement path "" has no module identity.');
  expect(unknowns).toContain(
    "Go replacement path ./dep has no module identity.",
  );
  expect(unknowns).toContain(
    'Go module path "" has no module identity; the replacement module is kept.',
  );
});

it("names a Windows artifact path the same way on every host", () => {
  const base = goReport(null);
  const report = goBinarySchema.parse({
    ...base,
    artifact: { ...base.artifact, path: "C:\\a\\b.exe" },
  });
  const view = projectGo(report);
  expect(view.artifact.path).toBe("C:\\a\\b.exe");
  expect(view.document.metadata.component.name).toBe("b.exe");
});

it("keeps a Go dependency whose Package URL matches the main module", () => {
  const view = projectGo(
    goReport({
      path: "example.com/tool",
      main: goModule("example.com/tool", "v1.0.0"),
      dependencies: [goModule("example.com/tool", "v1.0.0")],
      settings: [],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    }),
  );
  const purl = "pkg:golang/example.com/tool@v1.0.0";
  expect(view.document.dependencies).toEqual([
    { ref: purl, dependsOn: [`${purl}#1`] },
  ]);
});

it("names the parent input path when CycloneDX has no artifact path", () => {
  const evidence = createEvidence(
    undefined,
    { id: "layout", name: "Layout", version: "1" },
    {
      operation: "inspect_binary_layout",
      parameters: {},
      result: { input_path: "/artifacts/layout-input" },
      confidence: "observed",
    },
  );
  const result = projectAnalysisView(
    {
      evidenceId: evidence.evidence_id,
      operation: evidence.operation,
      normalizedResult: evidence.normalized_result,
      limitations: [],
    },
    VIEW,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected an unsupported parent");
  expect(result.error).toBeInstanceOf(AnalysisUnsupportedTargetError);
  if (!(result.error instanceof AnalysisUnsupportedTargetError))
    throw result.error;
  expect(result.error.path).toBe("/artifacts/layout-input");
});

it("refuses a Go parent whose subject does not match the report", () => {
  const report = goReport(null);
  const parent = parentFor("inspect_go_binary", report);
  if (parent.subject == null) throw new Error("Expected a subject");
  const result = projectAnalysisView(
    {
      ...parent,
      subject: { ...parent.subject, digest: { sha256: "b".repeat(64) } },
    },
    VIEW,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a subject refusal");
  expect(result.error).toBeInstanceOf(AnalysisInputError);
});
