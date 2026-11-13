import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PeResourcesService } from "./PeResourcesService.js";
import { PE_RESOURCES_PROVIDER } from "../../domain/investigationProviders.js";
import { inspectPeResourcesInputSchema } from "../../domain/native/peResources.js";
import {
  BYTE_PRESERVING_CODE_PAGE,
  DEFAULT_CODE_PAGE,
  RESOURCE_CODE_PAGES,
} from "../../domain/native/delphiForm.js";
import { parsePeResources } from "../../native/pe/PeResourceParser.js";
import { peResourceFixture } from "../../native/pe/PeResources.fixture.js";
import { ok } from "../../domain/result.js";
import { parseEvidence } from "../../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const observedReport = () => {
  const { bytes } = peResourceFixture();
  return parsePeResources(
    bytes,
    {
      path: "/fixtures/example.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({ path: "/fixtures/example.exe" }),
  );
};

const validRoot = (location: { offset: number; bytes: number }) => ({
  location,
  flags: [],
  child_position: null,
  class_name: null,
  component_name: null,
  properties: [],
  children: [],
  unknown: null,
});

const signatureAt = (location: { offset: number; bytes: number }) => ({
  offset: location.offset,
  bytes: 4,
});

const rootAfterSignature = (location: { offset: number; bytes: number }) => ({
  offset: location.offset + 4,
  bytes: Math.max(0, location.bytes - 4),
});

const codePageFields = (declared: number) => {
  if (declared === 0)
    return {
      declared_code_page: 0,
      code_page: DEFAULT_CODE_PAGE,
      code_page_source: "default" as const,
    };
  const label = RESOURCE_CODE_PAGES[declared];
  return label === undefined
    ? {
        declared_code_page: declared,
        code_page: BYTE_PRESERVING_CODE_PAGE,
        code_page_source: "unsupported" as const,
      }
    : {
        declared_code_page: declared,
        code_page: label,
        code_page_source: "resource" as const,
      };
};

const applySignatureVersionMismatch = (
  report: Awaited<ReturnType<typeof observedReport>>,
): void => {
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  // detectDelphiFormSignature defines a one-to-one pairing; TPF0 cannot
  // carry boVersion1.
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion1",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...codePageFields(resource.code_page),
      root: validRoot(rootAfterSignature(resource.payload.location)),
    },
  ];
};

const applyCodePageSourceMismatch = (
  report: Awaited<ReturnType<typeof observedReport>>,
): void => {
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  // 1252 is a supported page, so claiming the byte-preserving fallback
  // misreports the provenance.
  resource.code_page = 1252;
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      declared_code_page: 1252,
      code_page: "latin1",
      code_page_source: "unsupported",
      root: validRoot(rootAfterSignature(resource.payload.location)),
    },
  ];
};

const applyFormGeometryCase = (
  report: Awaited<ReturnType<typeof observedReport>>,
  problem: string,
): void => {
  const resource = report.resources[2]!;
  const payload = resource.payload.location;
  const signature =
    problem === "form-signature-not-four-bytes"
      ? { offset: payload.offset, bytes: 0 }
      : problem === "form-root-not-after-signature"
        ? signatureAt(payload)
        : { offset: payload.offset + 1, bytes: 4 };
  const root =
    problem === "form-root-not-after-signature"
      ? validRoot(payload)
      : problem === "form-signature-not-four-bytes"
        ? validRoot(rootAfterSignature(payload))
        : validRoot({ offset: payload.offset + 5, bytes: 0 });
  const prefix =
    problem === "form-prefix-empty-but-present"
      ? {
          location: { offset: payload.offset, bytes: 0 },
          bytes_hex: "",
          note: "test prefix",
        }
      : null;
  report.delphi_forms = [
    {
      resource_index: 2,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signature,
      prefix,
      ...codePageFields(resource.code_page),
      root,
    },
  ];
};

it.each([
  "different-path",
  "outside-range",
  "wrong-coverage",
  "bad-icon-reference",
  "form-points-at-icon-resource",
  "form-signature-outside-payload",
  "form-code-page-mismatch",
  "form-code-page-source-mismatch",
  "form-signature-version-mismatch",
  "form-value-outside-payload",
  "form-signature-not-four-bytes",
  "form-root-not-after-signature",
  "form-prefix-missing-before-signature",
  "form-prefix-empty-but-present",
  "mismatched-directory-path",
  "outside-directory-entry",
  "outside-directory-name",
])(
  "rejects invalid provider output before creating Evidence: %s",
  async (problem) => {
    const report = await observedReport();
    if (problem === "different-path") report.artifact.path = "/other.exe";
    if (problem === "outside-range")
      report.resources[0]!.payload.location.offset = report.artifact.bytes;
    if (problem === "wrong-coverage") report.coverage.resources = 99;
    if (problem === "bad-icon-reference")
      report.icon_groups[0]!.images[0]!.candidate_resource_indices = [999];
    if (problem === "form-code-page-mismatch")
      report.delphi_forms = [
        {
          // The declared page must be the resource's own declaration: this
          // form claims the opposite classification of what resource 2 has.
          resource_index: 2,
          signature: "TPF0",
          version: "boVersion0",
          signature_location: signatureAt(
            report.resources[2]!.payload.location,
          ),
          prefix: null,
          declared_code_page: report.resources[2]!.code_page === 0 ? 1252 : 0,
          code_page: "windows-1252",
          code_page_source:
            report.resources[2]!.code_page === 0 ? "resource" : "default",
          root: validRoot(
            rootAfterSignature(report.resources[2]!.payload.location),
          ),
        },
      ];
    if (problem === "form-points-at-icon-resource")
      report.delphi_forms = [
        {
          // Resource 0 is an RT_ICON, not the RT_RCDATA the form claims.
          resource_index: 0,
          signature: "TPF0",
          version: "boVersion0",
          signature_location: { offset: 0x400, bytes: 4 },
          prefix: null,
          declared_code_page: 0,
          code_page: "windows-1252",
          code_page_source: "default",
          root: validRoot(rootAfterSignature({ offset: 0x400, bytes: 4 })),
        },
      ];
    if (problem === "form-signature-outside-payload")
      report.delphi_forms = [
        {
          // Resource 2 is the RT_RCDATA payload, but the signature is outside it.
          resource_index: 2,
          signature: "TPF0",
          version: "boVersion0",
          signature_location: {
            offset: report.artifact.bytes,
            bytes: 4,
          },
          prefix: null,
          declared_code_page: 0,
          code_page: "windows-1252",
          code_page_source: "default",
          root: validRoot(
            rootAfterSignature(report.resources[2]!.payload.location),
          ),
        },
      ];
    if (problem === "form-code-page-source-mismatch")
      applyCodePageSourceMismatch(report);
    if (problem === "form-signature-version-mismatch")
      applySignatureVersionMismatch(report);
    if (problem === "form-value-outside-payload") {
      const index = report.resources.findIndex(
        (resource) => resource.type.kind === "id" && resource.type.id === 10,
      );
      const resource = report.resources[index]!;
      const payload = resource.payload.location;
      report.delphi_forms = [
        {
          resource_index: index,
          signature: "TPF0",
          version: "boVersion0",
          signature_location: signatureAt(payload),
          prefix: null,
          declared_code_page: resource.code_page,
          code_page: "windows-1252",
          code_page_source: resource.code_page === 0 ? "default" : "resource",
          root: {
            location: rootAfterSignature(payload),
            flags: [],
            child_position: null,
            class_name: null,
            component_name: null,
            properties: [
              {
                name: {
                  text: "Items",
                  bytes_hex: "",
                  code_page: "windows-1252",
                  location: payload,
                },
                value_type: "vaList",
                value: {
                  kind: "list",
                  items: [],
                  location: {
                    offset: payload.offset,
                    bytes: payload.bytes + 4,
                  },
                },
                location: payload,
              },
            ],
            children: [],
            unknown: null,
          },
        },
      ];
    }
    if (
      problem === "form-signature-not-four-bytes" ||
      problem === "form-root-not-after-signature" ||
      problem === "form-prefix-missing-before-signature" ||
      problem === "form-prefix-empty-but-present"
    )
      applyFormGeometryCase(report, problem);
    if (problem === "mismatched-directory-path")
      report.directories[1]!.path = [];
    if (problem === "outside-directory-entry")
      report.directories[1]!.entry_locations[0] = {
        offset: report.artifact.bytes,
        bytes: 8,
      };
    if (problem === "outside-directory-name") {
      const directory = report.directories.find(
        (item) => item.path[1]?.kind === "name",
      );
      const identity = directory?.path[1];
      if (directory === undefined || identity?.kind !== "name")
        throw new Error("Missing named directory fixture");
      directory.path[1] = {
        ...identity,
        location: { offset: report.artifact.bytes, bytes: 2 },
      };
    }
    const service = new PeResourcesService({
      identity: PE_RESOURCES_PROVIDER,
      inspect: () => Promise.resolve(ok(report)),
    });
    const outcome = await service.inspect({ path: "/fixtures/example.exe" });
    expect(outcome).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  },
);

it("rejects a non-default label for a zero declared code page", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  resource.code_page = 0;
  // A zero declared page always decodes as windows-1252; any other label is
  // not the observation the producer could have made.
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      declared_code_page: 0,
      code_page: "utf-8",
      code_page_source: "default",
      root: validRoot(rootAfterSignature(resource.payload.location)),
    },
  ];
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  expect(
    await service.inspect({ path: "/fixtures/example.exe" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
});

it("rejects nested form text whose code page contradicts the form", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const pages = codePageFields(resource.code_page);
  const otherPage = pages.code_page === "utf-8" ? "latin1" : "utf-8";
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...pages,
      root: {
        ...validRoot(rootAfterSignature(resource.payload.location)),
        properties: [
          {
            name: {
              text: "Caption",
              bytes_hex: "43",
              code_page: otherPage,
              location: resource.payload.location,
            },
            value_type: "vaNull",
            value: { kind: "null", location: resource.payload.location },
            location: resource.payload.location,
          },
        ],
      },
    },
  ];
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  expect(
    await service.inspect({ path: "/fixtures/example.exe" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
});

const formWithStringValue = async (
  valueType: string,
  valueCodePage: string,
) => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  resource.code_page = 1251;
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      declared_code_page: 1251,
      code_page: "windows-1251",
      code_page_source: "resource",
      root: {
        ...validRoot(rootAfterSignature(resource.payload.location)),
        properties: [
          {
            name: {
              text: "Caption",
              bytes_hex: "43",
              code_page: "windows-1251",
              location: resource.payload.location,
            },
            value_type: valueType,
            value: {
              kind: "string",
              text: "OK",
              bytes_hex: "4f4b",
              code_page: valueCodePage,
              declared_bytes: 2,
              truncated: false,
              location: resource.payload.location,
            },
            location: resource.payload.location,
          },
        ],
      },
    },
  ];
  return report;
};

it("rejects a string value whose code page contradicts its value type", async () => {
  const report = await formWithStringValue("vaString", "utf-8");
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  expect(
    await service.inspect({ path: "/fixtures/example.exe" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
});

it("accepts explicit UTF-8 form text on a non-UTF-8 resource page", async () => {
  const report = await formWithStringValue("vaUTF8String", "utf-8");
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  expect(
    await service.inspect({ path: "/fixtures/example.exe" }),
  ).toMatchObject({ ok: true });
});

it("rejects a property whose value type contradicts its decoded value", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const pages = codePageFields(resource.code_page);
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...pages,
      root: {
        ...validRoot(rootAfterSignature(resource.payload.location)),
        properties: [
          {
            name: {
              text: "Tag",
              bytes_hex: "54",
              code_page: pages.code_page,
              location: resource.payload.location,
            },
            value_type: "vaInt32",
            value: {
              kind: "boolean",
              value: true,
              location: resource.payload.location,
            },
            location: resource.payload.location,
          },
        ],
      },
    },
  ];
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  expect(
    await service.inspect({ path: "/fixtures/example.exe" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
});

it("rejects a signature-bearing form without a root", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...codePageFields(resource.code_page),
      // A provider that reports a recognized signature without the explicit
      // unknown root the decoder always produces.
      root: null,
    } as unknown as (typeof report.delphi_forms)[number],
  ];
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  expect(
    await service.inspect({ path: "/fixtures/example.exe" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
});

it.each([
  ["i386 PE32", 0x014c, "pe32", "x86"],
  ["AMD64 PE32+", 0x8664, "pe32-plus", "x86_64"],
  ["ARM PE32", 0x01c0, "pe32", "arm"],
  ["Thumb PE32", 0x01c2, "pe32", "arm"],
  ["ARMNT PE32", 0x01c4, "pe32", "arm"],
  ["ARM64 PE32+", 0xaa64, "pe32-plus", "arm64"],
  ["AMD64 machine with PE32 magic", 0x8664, "pe32", null],
  ["i386 machine with PE32+ magic", 0x014c, "pe32-plus", null],
  ["ReadyToRun Linux override", 0x8664 ^ 0x7b79, "pe32-plus", null],
  ["unknown machine", 0x01f0, "pe32", null],
] as const)(
  "names the subject architecture from the COFF machine: %s",
  async (_case, machine, format, architecture) => {
    const report = await observedReport();
    report.machine = machine;
    report.format = format;
    const service = new PeResourcesService({
      identity: PE_RESOURCES_PROVIDER,
      inspect: () => Promise.resolve(ok(report)),
    });
    const result = await service.inspect({ path: report.artifact.path });
    if (!result.ok) throw result.error;
    expect(result.value.subject?.architecture ?? null).toBe(architecture);
  },
);

it("retains a completed observation on late cancellation and keeps output errors primary", async () => {
  const report = await observedReport();
  const controller = new AbortController();
  const reason = { request: "late PE cancellation" };
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const late = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(late).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  if (!late.ok) {
    expect(late.error.cause).toBe(reason);
    expect(parseEvidence(late.error.partialObservation)).toMatchObject({
      operation: "inspect_pe_resources",
      subject: { architecture: "x86" },
      normalized_result: report,
    });
  }

  const malformed = await observedReport();
  malformed.artifact.path = "/other.exe";
  const outputController = new AbortController();
  const invalid = await new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => {
      outputController.abort();
      return Promise.resolve(ok(malformed));
    },
  }).inspect(
    { path: "/fixtures/example.exe" },
    { signal: outputController.signal },
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error).toBeInstanceOf(AnalysisOutputError);
});

it.each([
  null,
  "caller cancellation",
  { request: "opaque caller value" },
  new Error("caller failure"),
  new AnalysisOutputError("caller_operation", "caller-owned cleanup", {
    cleanup: {
      reason: "unresolved caller resource",
      resources: ["caller resource"],
    },
  }),
])(
  "preserves an opaque admission cancellation reason without invoking the reader: %j",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    let calls = 0;
    const service = new PeResourcesService({
      identity: PE_RESOURCES_PROVIDER,
      inspect: async () => {
        calls += 1;
        throw new Error("cancelled admission must not invoke the reader");
      },
    });
    const result = await service.inspect(null, { signal: controller.signal });
    if (result.ok) throw new Error("expected cancelled admission");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.partialObservation).toBeUndefined();
    expect(calls).toBe(0);
    if (reason instanceof AnalysisOutputError)
      expect(reason.cleanupIncomplete).toBe(true);
  },
);
