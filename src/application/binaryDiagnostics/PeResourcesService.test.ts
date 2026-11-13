import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PeResourcesService } from "./PeResourcesService.js";
import { PE_RESOURCES_PROVIDER } from "../../domain/investigationProviders.js";
import { inspectPeResourcesInputSchema } from "../../domain/native/peResources.js";
import {
  BYTE_PRESERVING_CODE_PAGE,
  DEFAULT_CODE_PAGE,
  DELPHI_FORM_FLOAT_NOTES,
  MAX_DELPHI_FORM_OBJECTS,
  MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES,
  RESOURCE_CODE_PAGES,
} from "../../domain/native/delphiForm.js";
import {
  delphiBinary,
  delphiBytes,
  delphiCollection,
  delphiCollectionItem,
  delphiComponent,
  delphiFloat32,
  delphiFloat64,
  delphiForm,
  delphiInt8,
  delphiInt32,
  delphiLString,
  delphiProperty,
  delphiUtf8String,
} from "../../native/pe/DelphiForm.fixture.js";
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

const declaredBytes = (value: number): Buffer => {
  const raw = Buffer.alloc(4);
  raw.writeUInt32LE(value, 0);
  return raw;
};

const label = (text: string, offset: number, codePage = DEFAULT_CODE_PAGE) => {
  const raw = Buffer.from(text, "latin1");
  return {
    text,
    bytes_hex: raw.toString("hex"),
    code_page: codePage,
    location: { offset, bytes: 1 + raw.length },
  };
};

const validRoot = (
  location: { offset: number; bytes: number },
  codePage = DEFAULT_CODE_PAGE,
) => {
  const class_name = label("TForm1", location.offset, codePage);
  const component_name = label(
    "Form1",
    location.offset + class_name.location.bytes,
    codePage,
  );
  return {
    location,
    flags: [],
    child_position: null,
    class_name,
    component_name,
    properties: [],
    children: [],
    unknown: null,
  };
};

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
                  bytes_hex: "4974656d73",
                  code_page: "windows-1252",
                  location: { offset: payload.offset, bytes: 6 },
                },
                value_type: "vaList",
                value: {
                  kind: "list",
                  items: [],
                  terminated: true,
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

const stoppedRoot = (
  report: Awaited<ReturnType<typeof observedReport>>,
  form: (typeof report.delphi_forms)[number],
  stopEnd: number,
  overrides: Record<string, unknown> = {},
): typeof form.root => {
  const root = form.root;
  const payload = report.resources[form.resource_index]?.payload.location;
  const payloadEnd =
    payload === undefined ? stopEnd : payload.offset + payload.bytes;
  const tail = Math.max(0, payloadEnd - stopEnd);
  return {
    ...root,
    ...overrides,
    location: {
      offset: root.location.offset,
      bytes: stopEnd - root.location.offset,
    },
    unknown: {
      reason: "stopped",
      bytes_hex: "00".repeat(Math.min(tail, 128)),
      truncated: tail > 128,
      location: { offset: stopEnd, bytes: tail },
    },
  } as never;
};

const reportWithFormPrefix = async (prefixBytes: number) => {
  const body = delphiForm(
    delphiComponent("TForm1", "Form1", [
      delphiProperty("Blob", delphiBinary(512)),
    ]),
  );
  if (prefixBytes <= MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES) {
    // Parse a real prefix so the baseline root keeps decoder geometry.
    return reportForPayload(
      prefixBytes === 0
        ? body
        : Buffer.concat([Buffer.alloc(prefixBytes), body]),
    );
  }
  // Only an over-window rejection case needs a form the decoder cannot emit.
  const report = await reportForPayload(body);
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const formPayload = resource.payload.location;
  const pages = codePageFields(resource.code_page);
  const signature = { offset: formPayload.offset + prefixBytes, bytes: 4 };
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signature,
      prefix: {
        location: { offset: formPayload.offset, bytes: prefixBytes },
        bytes_hex: "00".repeat(prefixBytes),
        note: "test prefix",
      },
      ...pages,
      root: validRoot(
        {
          offset: signature.offset + 4,
          bytes: formPayload.bytes - prefixBytes - 4,
        },
        pages.code_page,
      ),
    },
  ];
  return report;
};

const reportWithSyntheticValue = async (
  valueType: string,
  value: Record<string, unknown>,
  valueBytes: number,
) => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("Value", root.location.offset + 13, form.code_page);
  const markerOnly =
    value.kind === "null" || value.kind === "nil" || value.kind === "boolean";
  const valueOffset =
    name.location.offset + name.location.bytes + (markerOnly ? 0 : 1);
  const valueLocation = {
    offset: valueOffset,
    bytes: valueBytes,
  };
  const property = {
    name,
    value_type: valueType,
    value: { ...value, location: valueLocation } as never,
    location: {
      offset: name.location.offset,
      bytes: valueOffset - name.location.offset + valueBytes,
    },
  };
  report.delphi_forms = [
    {
      ...form,
      root: stoppedRoot(
        report,
        form,
        valueLocation.offset + valueLocation.bytes,
        { properties: [property], children: [] },
      ),
    },
  ];
  return report;
};

const reportWithBuiltSyntheticValue = async (
  valueType: string,
  buildValue: (
    location: {
      offset: number;
      bytes: number;
    },
    codePage: string,
  ) => Record<string, unknown>,
  valueBytes: number,
) => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("Value", root.location.offset + 13, form.code_page);
  const valueOffset = name.location.offset + name.location.bytes + 1;
  const property = {
    name,
    value_type: valueType,
    value: {
      ...buildValue({ offset: valueOffset, bytes: valueBytes }, form.code_page),
      location: { offset: valueOffset, bytes: valueBytes },
    } as never,
    location: {
      offset: name.location.offset,
      bytes: valueOffset - name.location.offset + valueBytes,
    },
  };
  report.delphi_forms = [
    {
      ...form,
      root: stoppedRoot(report, form, valueOffset + valueBytes, {
        properties: [property],
        children: [],
      }),
    },
  ];
  return report;
};

const nestedComponentForm = (levels: number): Buffer => {
  let child = delphiComponent("TLeaf", "Leaf1");
  for (let index = 0; index < levels; index += 1)
    child = delphiComponent(
      `TLevel${String(index)}`,
      `Level${String(index)}`,
      [],
      {
        children: [child],
      },
    );
  return delphiForm(child);
};

const nestedListForm = (levels: number): Buffer => {
  let nested = delphiBytes(1, 0);
  for (let index = 0; index < levels; index += 1)
    nested = Buffer.concat([delphiBytes(1), nested, delphiBytes(0)]);
  return delphiForm(
    delphiComponent("TForm1", "Form1", [delphiProperty("Deep", nested)]),
  );
};

const stopRoot = (report: Awaited<ReturnType<typeof observedReport>>): void => {
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const lastChild = root.children.at(-1);
  const lastProperty = root.properties.at(-1);
  const stopEnd =
    lastChild !== undefined
      ? lastChild.location.offset + lastChild.location.bytes
      : lastProperty !== undefined
        ? lastProperty.location.offset + lastProperty.location.bytes
        : root.component_name !== null
          ? root.component_name.location.offset +
            root.component_name.location.bytes
          : root.class_name !== null
            ? root.class_name.location.offset + root.class_name.location.bytes
            : root.location.offset;
  report.delphi_forms = [{ ...form, root: stoppedRoot(report, form, stopEnd) }];
};

it("accepts the synthetic form baseline", async () => {
  expect(await inspectReport(await reportWithFormPrefix(0))).toMatchObject({
    ok: true,
  });
});

it("accepts a valid synthetic scalar value", async () => {
  const report = await reportWithSyntheticValue(
    "vaInt8",
    { kind: "integer", text: "1", bytes_hex: "01", width: 8, signed: true },
    1,
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("accepts a valid synthetic identifier value", async () => {
  const report = await reportWithSyntheticValue(
    "vaIdent",
    { kind: "identifier", text: "A", bytes_hex: "41" },
    2,
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("accepts a valid synthetic float value", async () => {
  const report = await reportWithSyntheticValue(
    "vaSingle",
    {
      kind: "float",
      text: "1.5",
      bytes_hex: "0000c03f",
      note: DELPHI_FORM_FLOAT_NOTES.vaSingle ?? "",
    },
    4,
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("accepts a form prefix at the decoder probe-window boundary", async () => {
  const report = await reportWithFormPrefix(16);
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects a form prefix longer than the decoder probe window", async () => {
  const report = await reportWithFormPrefix(17);
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a form prefix without its retained bytes", async () => {
  const report = await reportWithFormPrefix(16);
  const form = report.delphi_forms[0];
  if (form?.prefix === null || form?.prefix === undefined)
    throw new Error("Missing form prefix");
  report.delphi_forms = [
    { ...form, prefix: { ...form.prefix, bytes_hex: "" } },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

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
              bytes_hex: "43617074696f6e",
              code_page: otherPage,
              location: { offset: resource.payload.location.offset, bytes: 8 },
            },
            value_type: "vaNull",
            value: {
              kind: "null",
              location: { offset: resource.payload.location.offset, bytes: 1 },
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

it("rejects a form label whose retained bytes decode to another text", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  const componentName = form?.root.component_name;
  if (
    form === undefined ||
    componentName === null ||
    componentName === undefined
  )
    throw new Error("Missing component name");
  // The bytes still decode to "Form1"; only the published text changed.
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        component_name: { ...componentName, text: "B" },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an identifier whose text disagrees with its retained bytes", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("Ident", root.location.offset + 13, form.code_page);
  const valueLocation = {
    offset: name.location.offset + name.location.bytes,
    bytes: 2,
  };
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        properties: [
          {
            name,
            value_type: "vaIdent",
            value: {
              kind: "identifier",
              text: "B",
              bytes_hex: "41",
              location: valueLocation,
            },
            location: {
              offset: name.location.offset,
              bytes: name.location.bytes + valueLocation.bytes,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a short label longer than one length byte can declare", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const raw = Buffer.alloc(256, 0x41);
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        component_name: {
          text: raw.toString("latin1"),
          bytes_hex: raw.toString("hex"),
          code_page: form.code_page,
          location: { offset: form.root.location.offset + 13, bytes: 257 },
        },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an identifier longer than one length byte can declare", async () => {
  const raw = Buffer.alloc(256, 0x41);
  const report = await reportWithSyntheticValue(
    "vaIdent",
    {
      kind: "identifier",
      text: raw.toString("latin1"),
      bytes_hex: raw.toString("hex"),
    },
    257,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

const formWithStringValue = async (
  valueType: string,
  valueCodePage: string,
  options: {
    declaredBytes?: number;
    bytesHex?: string;
    retainedBytes?: number;
    truncated?: boolean;
    decodeTruncated?: boolean;
  } = {},
) => {
  const payload = delphiForm(
    delphiComponent("TForm1", "Form1", [
      delphiProperty("Caption", delphiUtf8String("OK")),
    ]),
  );
  const report = await reportForPayload(payload, 1251);
  const form = report.delphi_forms[0];
  const property = form?.root.properties[0];
  if (form === undefined || property?.value.kind !== "string")
    throw new Error("Missing UTF-8 string fixture");
  const retainedBytes =
    options.retainedBytes ?? property.value.bytes_hex.length / 2;
  const prefixBytes = valueType === "vaString" ? 1 : 4;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        properties: [
          {
            ...property,
            value_type: valueType,
            value: {
              ...property.value,
              bytes_hex: options.bytesHex ?? property.value.bytes_hex,
              code_page: valueCodePage,
              declared_bytes:
                options.declaredBytes ?? property.value.declared_bytes,
              truncated: options.truncated ?? property.value.truncated,
              decode_truncated:
                options.decodeTruncated ?? property.value.decode_truncated,
              location: {
                offset: property.value.location.offset,
                bytes: prefixBytes + retainedBytes,
              },
            },
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

it("rejects a complete string whose text disagrees with its retained bytes", async () => {
  const report = await formWithStringValue("vaString", "windows-1251", {
    declaredBytes: 1,
    bytesHex: "41",
    retainedBytes: 1,
    truncated: false,
    decodeTruncated: false,
  });
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
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

const formWithBuiltProperty = async (
  valueType: string,
  buildValue: (location: {
    offset: number;
    bytes: number;
  }) => Record<string, unknown>,
) => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const pages = codePageFields(resource.code_page);
  const location = rootAfterSignature(resource.payload.location);
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...pages,
      root: {
        ...validRoot(location, pages.code_page),
        properties: [
          {
            name: label("Value", location.offset, pages.code_page),
            value_type: valueType,
            value: {
              ...buildValue(location),
              location,
            } as never,
            location,
          },
        ],
      },
    },
  ];
  return report;
};

const formWithProperty = (valueType: string, value: Record<string, unknown>) =>
  formWithBuiltProperty(valueType, () => value);

const inspectReport = async (
  report: Awaited<ReturnType<typeof observedReport>>,
) => {
  const service = new PeResourcesService({
    identity: PE_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });
  return service.inspect({ path: "/fixtures/example.exe" });
};

const reportForPayload = async (payload: Buffer, codePage?: number) => {
  const fixture = peResourceFixture(false, [
    { type: 10, name: 7, language: 1033, payload },
  ]);
  if (codePage !== undefined)
    fixture.bytes.writeUInt32LE(codePage, (fixture.dataOffsets[0] ?? 0) + 8);
  return parsePeResources(
    fixture.bytes,
    {
      path: "/fixtures/example.exe",
      bytes: fixture.bytes.length,
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({ path: "/fixtures/example.exe" }),
  );
};

it("rejects a property whose value type contradicts its decoded value", async () => {
  const report = await formWithProperty("vaInt32", {
    kind: "boolean",
    value: true,
  });
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it.each(["invented", "unknown_value_type(999)", "unknown_value_type(01)"])(
  "rejects undeclared value type %s even when the value is unknown",
  async (valueType) => {
    const report = await formWithProperty(valueType, {
      kind: "unknown",
      reason: "stopped",
      bytes_hex: "",
      truncated: true,
    });
    expect(await inspectReport(report)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  },
);

it("rejects an unknown value whose preview omits bytes from a nonempty range", async () => {
  const report = await reportWithSyntheticValue(
    "vaInt8",
    { kind: "unknown", reason: "stopped", bytes_hex: "", truncated: false },
    1,
  );
  stopRoot(report);
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an unknown value whose preview exceeds a zero-byte range", async () => {
  const report = await reportWithSyntheticValue(
    "vaInt8",
    { kind: "unknown", reason: "stopped", bytes_hex: "ff", truncated: false },
    0,
  );
  stopRoot(report);
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an integer whose value does not fit its declared width", async () => {
  const report = await formWithProperty("vaInt8", {
    kind: "integer",
    text: "999",
    bytes_hex: "e7",
    width: 8,
    signed: true,
  });
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an integer projection whose retained bytes disagree", async () => {
  const report = await formWithProperty("vaInt8", {
    kind: "integer",
    text: "1",
    bytes_hex: "ff",
    width: 8,
    signed: true,
  });
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an integer whose source range is not its encoded width", async () => {
  const report = await reportWithSyntheticValue(
    "vaInt8",
    { kind: "integer", text: "1", bytes_hex: "01", width: 8, signed: true },
    0,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a marker-only scalar whose source range is empty", async () => {
  const report = await reportWithSyntheticValue(
    "vaTrue",
    { kind: "boolean", value: true },
    0,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a float whose source range is not its encoded width", async () => {
  const report = await reportWithSyntheticValue(
    "vaSingle",
    {
      kind: "float",
      text: "1.5",
      bytes_hex: "0000c03f",
      note: DELPHI_FORM_FLOAT_NOTES.vaSingle ?? "",
    },
    0,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a list item whose declared value type contradicts its value", async () => {
  const report = await formWithBuiltProperty("vaList", (location) => ({
    kind: "list",
    items: [
      {
        value_type: "vaInt8",
        marker_location: location,
        value: { kind: "boolean", value: true, location },
      },
    ],
    terminated: true,
  }));
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a nested stop that does not propagate to its ancestors", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const location = rootAfterSignature(resource.payload.location);
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...codePageFields(resource.code_page),
      root: {
        ...validRoot(location),
        children: [
          {
            location: { offset: location.offset, bytes: 1 },
            flags: [],
            child_position: null,
            class_name: null,
            component_name: null,
            properties: [],
            children: [],
            unknown: {
              reason: "nested stop",
              bytes_hex: "",
              truncated: false,
              location: {
                offset: location.offset + 1,
                bytes: location.bytes - 1,
              },
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a nested unknown that does not start at the object end", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const location = root.location;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        unknown: {
          reason: "root suffix",
          bytes_hex: "",
          truncated: false,
          location: { offset: location.offset + location.bytes, bytes: 0 },
        },
        children: [
          {
            location: { offset: location.offset, bytes: 1 },
            flags: [],
            child_position: null,
            class_name: null,
            component_name: null,
            properties: [],
            children: [],
            unknown: {
              reason: "nested stop",
              bytes_hex: "aa",
              truncated: false,
              // The child ends at +1; its unknown starts one byte later, so
              // that gap would belong to neither the child nor its unknown.
              location: { offset: location.offset + 2, bytes: 1 },
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a child position whose retained bytes disagree", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const location = rootAfterSignature(resource.payload.location);
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...codePageFields(resource.code_page),
      root: {
        ...validRoot(location),
        flags: ["ffChildPos"],
        child_position: {
          kind: "integer",
          text: "1",
          bytes_hex: "ff",
          width: 8,
          signed: true,
          location,
        },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an object unknown whose preview omits its tail", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const tailBytes = 10;
  const rootLocation = {
    offset: root.location.offset,
    bytes: root.location.bytes - tailBytes,
  };
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        location: rootLocation,
        unknown: {
          reason: "stopped",
          bytes_hex: "",
          truncated: false,
          location: {
            offset: rootLocation.offset + rootLocation.bytes,
            bytes: tailBytes,
          },
        },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects sibling properties that reuse the same source ranges", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("V", root.location.offset + 13, form.code_page);
  const valueLocation = {
    offset: name.location.offset + name.location.bytes + 1,
    bytes: 1,
  };
  const property = {
    name,
    value_type: "vaInt8",
    value: {
      kind: "integer" as const,
      text: "1",
      bytes_hex: "01",
      width: 8 as const,
      signed: true,
      location: valueLocation,
    },
    location: {
      offset: name.location.offset,
      bytes: name.location.bytes + 2,
    },
  };
  report.delphi_forms = [
    {
      ...form,
      root: { ...root, properties: [property, { ...property }] },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a property value that reuses its name range", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("AB", root.location.offset + 13, form.code_page);
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        properties: [
          {
            name,
            value_type: "vaInt16",
            value: {
              kind: "integer",
              text: "16961",
              bytes_hex: "4142",
              width: 16,
              signed: true,
              location: { offset: name.location.offset, bytes: 2 },
            },
            location: {
              offset: name.location.offset,
              bytes: name.location.bytes,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a complete root whose structural value lost its terminator", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("Items", root.location.offset + 13, form.code_page);
  const valueOffset = name.location.offset + name.location.bytes + 1;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        properties: [
          {
            name,
            value_type: "vaList",
            value: {
              kind: "list",
              items: [],
              terminated: false,
              location: { offset: valueOffset, bytes: 0 },
            },
            location: {
              offset: name.location.offset,
              bytes: valueOffset - name.location.offset,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a declared ordinal whose unknown omits the type marker", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("N", root.location.offset + 13, form.code_page);
  const nameEnd = name.location.offset + name.location.bytes;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        unknown: {
          reason: "stopped",
          bytes_hex: "",
          truncated: false,
          location: {
            offset: root.location.offset + root.location.bytes,
            bytes: 0,
          },
        },
        properties: [
          {
            name,
            value_type: "vaInt32",
            value: {
              kind: "unknown",
              reason: "stopped",
              bytes_hex: "",
              truncated: false,
              location: { offset: nameEnd, bytes: 0 },
            },
            location: {
              offset: name.location.offset,
              bytes: name.location.bytes,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects an unknown value type that claims a consumed marker", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("N", root.location.offset + 13, form.code_page);
  const nameEnd = name.location.offset + name.location.bytes;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        unknown: {
          reason: "stopped",
          bytes_hex: "",
          truncated: false,
          location: {
            offset: root.location.offset + root.location.bytes,
            bytes: 0,
          },
        },
        properties: [
          {
            name,
            value_type: "unknown",
            value: {
              kind: "unknown",
              reason: "stopped",
              bytes_hex: "",
              truncated: false,
              location: { offset: nameEnd + 1, bytes: 0 },
            },
            location: {
              offset: name.location.offset,
              bytes: name.location.bytes + 1,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a property that follows a stopped value", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const first = label("A", root.location.offset + 13, form.code_page);
  const listOffset = first.location.offset + first.location.bytes + 1;
  const firstEnd = listOffset + 1;
  const second = label("B", firstEnd, form.code_page);
  const secondValueOffset = second.location.offset + second.location.bytes;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        unknown: {
          reason: "stopped",
          bytes_hex: "",
          truncated: false,
          location: {
            offset: root.location.offset + root.location.bytes,
            bytes: 0,
          },
        },
        properties: [
          {
            name: first,
            value_type: "vaList",
            value: {
              kind: "list",
              items: [
                {
                  value_type: "vaNull",
                  marker_location: { offset: listOffset, bytes: 1 },
                  value: {
                    kind: "null",
                    location: { offset: listOffset, bytes: 1 },
                  },
                },
              ],
              terminated: false,
              location: { offset: listOffset, bytes: 1 },
            },
            location: {
              offset: first.location.offset,
              bytes: firstEnd - first.location.offset,
            },
          },
          {
            name: second,
            value_type: "vaNull",
            value: {
              kind: "null",
              location: { offset: secondValueOffset, bytes: 1 },
            },
            location: {
              offset: second.location.offset,
              bytes: secondValueOffset + 1 - second.location.offset,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a stopped string whose text disagrees with its retained bytes", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("S", root.location.offset + 13, form.code_page);
  const valueOffset = name.location.offset + name.location.bytes + 1;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        unknown: {
          reason: "stopped",
          bytes_hex: "",
          truncated: false,
          location: {
            offset: root.location.offset + root.location.bytes,
            bytes: 0,
          },
        },
        properties: [
          {
            name,
            value_type: "vaString",
            value: {
              kind: "string",
              text: "B",
              bytes_hex: "41",
              code_page: form.code_page,
              declared_bytes: 2,
              truncated: true,
              decode_truncated: true,
              location: { offset: valueOffset, bytes: 2 },
            },
            location: {
              offset: name.location.offset,
              bytes: valueOffset + 2 - name.location.offset,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects list entries that reuse the same source ranges", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("Items", root.location.offset + 13, form.code_page);
  const listOffset = name.location.offset + name.location.bytes + 1;
  const entry = {
    value_type: "vaNull",
    marker_location: { offset: listOffset, bytes: 1 },
    value: {
      kind: "null" as const,
      location: { offset: listOffset, bytes: 1 },
    },
  };
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        properties: [
          {
            name,
            value_type: "vaList",
            value: {
              kind: "list",
              items: [entry, { ...entry }],
              terminated: true,
              location: { offset: listOffset, bytes: 2 },
            },
            location: {
              offset: name.location.offset,
              bytes: listOffset + 2 - name.location.offset,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a stopped child that has a later sibling", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const childStart = root.location.offset + 13;
  const secondStart = childStart + 2;
  const secondClass = label("TForm1", secondStart, form.code_page);
  const secondComponent = label(
    "Form1",
    secondStart + secondClass.location.bytes,
    form.code_page,
  );
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...root,
        unknown: {
          reason: "stopped",
          bytes_hex: "",
          truncated: false,
          location: {
            offset: root.location.offset + root.location.bytes,
            bytes: 0,
          },
        },
        children: [
          {
            location: { offset: childStart, bytes: 1 },
            flags: [],
            child_position: null,
            class_name: null,
            component_name: null,
            properties: [],
            children: [],
            unknown: {
              reason: "stopped",
              bytes_hex: "aa",
              truncated: false,
              location: { offset: childStart + 1, bytes: 1 },
            },
          },
          {
            location: { offset: secondStart, bytes: 13 },
            flags: [],
            child_position: null,
            class_name: secondClass,
            component_name: secondComponent,
            properties: [],
            children: [],
            unknown: null,
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it.each(["set", "collection"] as const)(
  "rejects an empty complete %s without a terminator range",
  async (kind) => {
    const report = await reportWithFormPrefix(0);
    const form = report.delphi_forms[0];
    if (form === undefined) throw new Error("Missing form");
    const root = form.root;
    const name = label("Empty", root.location.offset + 13, form.code_page);
    const valueOffset = name.location.offset + name.location.bytes + 1;
    const value =
      kind === "set"
        ? { kind, names: [], terminated: true }
        : { kind, items: [], terminated: true };
    report.delphi_forms = [
      {
        ...form,
        root: {
          ...root,
          properties: [
            {
              name,
              value_type: kind === "set" ? "vaSet" : "vaCollection",
              value: {
                ...value,
                location: { offset: valueOffset, bytes: 0 },
              } as never,
              location: {
                offset: name.location.offset,
                bytes: valueOffset - name.location.offset,
              },
            },
          ],
        },
      },
    ];
    expect(await inspectReport(report)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  },
);

it("rejects a complete collection item that consumes no source bytes", async () => {
  const report = await reportWithBuiltSyntheticValue(
    "vaCollection",
    (location) => ({
      kind: "collection",
      items: [
        {
          position: null,
          properties: [],
          location: { offset: location.offset, bytes: 0 },
        },
      ],
      terminated: true,
    }),
    1,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a stopped collection item that claims bytes after its marker", async () => {
  const report = await reportWithBuiltSyntheticValue(
    "vaCollection",
    (location) => ({
      kind: "collection",
      items: [
        {
          position: null,
          properties: [],
          location: { offset: location.offset, bytes: 3 },
        },
      ],
      terminated: false,
    }),
    3,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a list entry that follows a stopped nested list", async () => {
  const report = await reportWithBuiltSyntheticValue(
    "vaList",
    (location) => ({
      kind: "list",
      items: [
        {
          value_type: "vaList",
          marker_location: { offset: location.offset, bytes: 1 },
          value: {
            kind: "list",
            items: [],
            terminated: false,
            location: { offset: location.offset + 1, bytes: 0 },
          },
        },
        {
          value_type: "vaNull",
          marker_location: { offset: location.offset + 1, bytes: 1 },
          value: {
            kind: "null",
            location: { offset: location.offset + 1, bytes: 1 },
          },
        },
      ],
      terminated: false,
    }),
    2,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a terminated collection whose item property stopped", async () => {
  const report = await reportWithBuiltSyntheticValue(
    "vaCollection",
    (location, codePage) => {
      const name = label("V", location.offset + 1, codePage);
      const valueOffset = name.location.offset + name.location.bytes + 1;
      return {
        kind: "collection",
        items: [
          {
            position: null,
            properties: [
              {
                name,
                value_type: "vaList",
                value: {
                  kind: "list",
                  items: [],
                  terminated: false,
                  location: { offset: valueOffset, bytes: 0 },
                },
                location: {
                  offset: name.location.offset,
                  bytes: valueOffset - name.location.offset,
                },
              },
            ],
            location: {
              offset: location.offset,
              bytes: valueOffset - location.offset + 1,
            },
          },
        ],
        terminated: true,
      };
    },
    6,
  );
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes a decoded collection with framed items", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty(
          "Columns",
          delphiCollection(
            delphiCollectionItem(
              delphiInt8(0),
              delphiProperty("Width", delphiInt32(64)),
            ),
          ),
        ),
      ]),
    ),
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("publishes a collection whose item stopped after its position", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty(
          "Columns",
          Buffer.concat([delphiBytes(14), delphiInt8(5)]),
        ),
      ]),
    ),
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects duplicate decoded forms for one resource", async () => {
  const report = await reportForPayload(
    delphiForm(delphiComponent("TForm1", "Form1")),
  );
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  report.delphi_forms = [form, { ...form }];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a child position whose source range is not its encoded width", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const location = form.root.location;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        flags: ["ffChildPos"],
        child_position: {
          kind: "integer",
          text: "1",
          bytes_hex: "01",
          width: 8,
          signed: true,
          location,
        },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a child position without the ffChildPos flag", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const location = rootAfterSignature(resource.payload.location);
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(resource.payload.location),
      prefix: null,
      ...codePageFields(resource.code_page),
      root: {
        ...validRoot(location),
        child_position: {
          kind: "integer",
          text: "1",
          bytes_hex: "01",
          width: 8,
          signed: true,
          location,
        },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes a complete value whose hex preview is capped", async () => {
  const payload = delphiForm(
    delphiComponent("TForm1", "Form1", [
      delphiProperty("Blob", delphiBinary(129)),
    ]),
  );
  const { bytes } = peResourceFixture(false, [
    { type: 10, name: 7, language: 1033, payload },
  ]);
  const report = await parsePeResources(
    bytes,
    {
      path: "/fixtures/example.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({ path: "/fixtures/example.exe" }),
  );
  expect(report.delphi_forms[0]?.root.unknown).toBeNull();
  expect(report.delphi_forms[0]?.root.properties[0]?.value).toMatchObject({
    kind: "binary",
    declared_bytes: 129,
    truncated: true,
    decode_truncated: false,
  });
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("publishes a signature-only form with a disjoint unknown suffix", async () => {
  const report = await reportForPayload(Buffer.from("TPF0", "latin1"));
  expect(report.delphi_forms[0]?.root.location.bytes).toBe(0);
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("publishes a complete form followed by an unknown payload suffix", async () => {
  const report = await reportForPayload(
    Buffer.concat([
      delphiForm(delphiComponent("TForm1", "Form1")),
      delphiBytes(0xaa, 0xbb),
    ]),
  );
  expect(report.delphi_forms[0]?.root.unknown).not.toBeNull();
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("publishes a complete form with children followed by a payload suffix", async () => {
  const report = await reportForPayload(
    Buffer.concat([
      delphiForm(
        delphiComponent(
          "TForm1",
          "Form1",
          [delphiProperty("Width", delphiInt32(1))],
          { children: [delphiComponent("TButton", "Button1")] },
        ),
      ),
      delphiBytes(0xaa, 0xbb),
    ]),
  );
  expect(report.delphi_forms[0]?.root.unknown).not.toBeNull();
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects more decoded objects than the decoder budget retains", async () => {
  const report = await reportWithFormPrefix(0);
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  resource.code_page = 0;
  const pages = codePageFields(0);
  const childBytes = 6;
  const children = Array.from(
    { length: MAX_DELPHI_FORM_OBJECTS + 1 },
    (_, child) => {
      const offset = 9 + child * childBytes;
      return {
        location: { offset, bytes: childBytes },
        flags: [],
        child_position: null,
        class_name: label("A", offset, pages.code_page),
        component_name: label("B", offset + 2, pages.code_page),
        properties: [],
        children: [],
        unknown: null,
      };
    },
  );
  const rootEnd = 9 + children.length * childBytes + 1;
  resource.payload.location = { offset: 0, bytes: rootEnd };
  report.artifact.bytes = rootEnd;
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: { offset: 0, bytes: 4 },
      prefix: null,
      ...pages,
      root: {
        location: { offset: 4, bytes: rootEnd - 4 },
        flags: [],
        child_position: null,
        class_name: label("A", 4, pages.code_page),
        component_name: label("B", 6, pages.code_page),
        properties: [],
        children,
        unknown: null,
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects more properties than the decoder budget retains", async () => {
  const report = await reportWithFormPrefix(0);
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  resource.code_page = 0;
  const pages = codePageFields(0);
  const properties = Array.from({ length: 8193 }, (_, property) => {
    const name = label("P", 8 + property * 3, pages.code_page);
    return {
      name,
      value_type: "vaNull",
      value: {
        kind: "null" as const,
        location: {
          offset: name.location.offset + name.location.bytes,
          bytes: 1,
        },
      },
      location: {
        offset: name.location.offset,
        bytes: name.location.bytes + 1,
      },
    };
  });
  const rootEnd = 8 + properties.length * 3 + 2;
  resource.payload.location = { offset: 0, bytes: rootEnd };
  report.artifact.bytes = rootEnd;
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: { offset: 0, bytes: 4 },
      prefix: null,
      ...pages,
      root: {
        location: { offset: 4, bytes: rootEnd - 4 },
        flags: [],
        child_position: null,
        class_name: label("A", 4, pages.code_page),
        component_name: label("B", 6, pages.code_page),
        properties,
        children: [],
        unknown: null,
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects more values than the decoder budget retains", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty("Blob", delphiBinary(40000)),
      ]),
    ),
  );
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const root = form.root;
  const name = label("Deep", root.location.offset + 13, form.code_page);
  const valueOffset = name.location.offset + name.location.bytes + 1;
  const items = Array.from({ length: 32769 }, (_, item) => ({
    value_type: "vaNull",
    marker_location: { offset: valueOffset + item, bytes: 1 },
    value: {
      kind: "null",
      location: { offset: valueOffset + item, bytes: 1 },
    },
  }));
  const propertyEnd = valueOffset + items.length + 1;
  report.delphi_forms = [
    {
      ...form,
      root: stoppedRoot(report, form, propertyEnd, {
        properties: [
          {
            name,
            value_type: "vaList",
            value: {
              kind: "list",
              items,
              terminated: true,
              location: { offset: valueOffset, bytes: items.length + 1 },
            },
            location: {
              offset: name.location.offset,
              bytes: propertyEnd - name.location.offset,
            },
          },
        ],
        children: [],
      }),
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a completed suffix root whose ffChildPos position is missing", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const resource = report.resources[form.resource_index]!;
  const payload = resource.payload.location;
  const start = form.root.location.offset;
  const className = label("T", start + 1, form.code_page);
  const componentName = label(
    "F",
    className.location.offset + className.location.bytes,
    form.code_page,
  );
  const namesEnd = componentName.location.offset + componentName.location.bytes;
  const rootEnd = namesEnd + 2;
  const tail = payload.offset + payload.bytes - rootEnd;
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        location: { offset: start, bytes: rootEnd - start },
        flags: ["ffChildPos"],
        child_position: null,
        class_name: className,
        component_name: componentName,
        properties: [],
        children: [],
        unknown: {
          reason: "suffix",
          bytes_hex: "00".repeat(Math.min(tail, 128)),
          truncated: tail > 128,
          location: { offset: rootEnd, bytes: tail },
        },
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects component names that reuse the class name range", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  const className = form.root.class_name;
  if (className === null) throw new Error("Missing class name");
  report.delphi_forms = [
    {
      ...form,
      root: { ...form.root, component_name: className, class_name: className },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a complete object that omits its section terminators", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  report.delphi_forms = [
    { ...form, root: validRoot(form.root.location, form.code_page) },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it.each([32, 33])(
  "publishes the decoder boundary for %i nested components",
  async (levels) => {
    expect(
      await inspectReport(await reportForPayload(nestedComponentForm(levels))),
    ).toMatchObject({ ok: true });
  },
);

it("publishes a list that stopped at the decoder depth limit", async () => {
  expect(
    await inspectReport(await reportForPayload(nestedListForm(33))),
  ).toMatchObject({ ok: true });
});

it("rejects a cyclic form tree before schema parsing", async () => {
  const report = await reportWithFormPrefix(0);
  const form = report.delphi_forms[0];
  if (form === undefined) throw new Error("Missing form");
  form.root.children.push(form.root);
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a complete object without class and component names", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const location = rootAfterSignature(resource.payload.location);
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
        ...validRoot(location, pages.code_page),
        class_name: null,
        component_name: null,
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects ffChildPos on a complete object without a child position", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const location = rootAfterSignature(resource.payload.location);
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
        ...validRoot(location, pages.code_page),
        flags: ["ffChildPos"],
        child_position: null,
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a complete string whose declared bytes are not retained", async () => {
  const report = await formWithStringValue("vaLString", "windows-1251", {
    declaredBytes: 100,
    bytesHex: "",
    retainedBytes: 0,
    truncated: false,
    decodeTruncated: false,
  });
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a fully consumed string marked decode-truncated", async () => {
  const report = await formWithStringValue("vaLString", "windows-1251", {
    declaredBytes: 2,
    bytesHex: "4f4b",
    retainedBytes: 2,
    truncated: true,
    decodeTruncated: true,
  });
  stopRoot(report);
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("rejects a fully consumed binary marked decode-truncated", async () => {
  const report = await reportWithSyntheticValue(
    "vaBinary",
    {
      kind: "binary",
      bytes_hex: "4142",
      declared_bytes: 2,
      truncated: true,
      decode_truncated: true,
    },
    6,
  );
  stopRoot(report);
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes a capped string whose preview matches its text", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty("Long", delphiLString("A".repeat(200))),
      ]),
    ),
  );
  expect(report.delphi_forms[0]?.root.properties[0]?.value).toMatchObject({
    kind: "string",
    truncated: true,
    decode_truncated: false,
  });
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects a capped string whose preview disagrees with its text", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty("Long", delphiLString("A".repeat(200))),
      ]),
    ),
  );
  const form = report.delphi_forms[0];
  const property = form?.root.properties[0];
  if (form === undefined || property?.value.kind !== "string")
    throw new Error("Missing long string");
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        properties: [
          {
            ...property,
            value: {
              ...property.value,
              text: `B${property.value.text.slice(1)}`,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes a capped UTF-8 preview that splits a multibyte sequence", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty("Long", delphiUtf8String(`${"A".repeat(127)}€`)),
      ]),
    ),
  );
  expect(report.delphi_forms[0]?.root.properties[0]?.value).toMatchObject({
    kind: "string",
    truncated: true,
  });
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("publishes a capped UTF-16BE string with a stripped BOM", async () => {
  const raw = Buffer.alloc(202);
  raw.writeUInt16BE(0xfeff, 0);
  for (let index = 0; index < 100; index += 1)
    raw.writeUInt16BE(0x41, 2 + index * 2);
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty(
          "Long",
          Buffer.concat([delphiBytes(12), declaredBytes(raw.length), raw]),
        ),
      ]),
    ),
    1201,
  );
  expect(report.delphi_forms[0]?.root.properties[0]?.value).toMatchObject({
    kind: "string",
    truncated: true,
    decode_truncated: false,
  });
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects a stopped capped string whose preview disagrees with its text", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty(
          "Long",
          Buffer.concat([
            delphiBytes(12),
            declaredBytes(300),
            Buffer.alloc(200, 0x41),
          ]),
        ),
      ]),
    ),
  );
  const form = report.delphi_forms[0];
  const property = form?.root.properties[0];
  if (form === undefined || property?.value.kind !== "string")
    throw new Error("Missing stopped string");
  expect(property.value).toMatchObject({
    truncated: true,
    decode_truncated: true,
  });
  report.delphi_forms = [
    {
      ...form,
      root: {
        ...form.root,
        properties: [
          {
            ...property,
            value: {
              ...property.value,
              text: `B${property.value.text.slice(1)}`,
            },
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes a zero-length stopped string inside a partial root", async () => {
  // The decoder charges the representation budget before taking any body
  // bytes, so a zero-length vaString can stop with only its length byte.
  const baseline = await reportWithFormPrefix(0);
  const page = baseline.delphi_forms[0]?.code_page ?? DEFAULT_CODE_PAGE;
  const report = await reportWithSyntheticValue(
    "vaString",
    {
      kind: "string",
      text: "",
      bytes_hex: "",
      code_page: page,
      declared_bytes: 0,
      truncated: true,
      decode_truncated: true,
    },
    1,
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects a float projection that does not match its retained bytes", async () => {
  const report = await formWithProperty("vaSingle", {
    kind: "float",
    text: "1",
    bytes_hex: "",
    note: "anything",
  });
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes decoded float projections that match their retained bytes", async () => {
  const report = await reportForPayload(
    delphiForm(
      delphiComponent("TForm1", "Form1", [
        delphiProperty("Ratio", delphiFloat32(1.5)),
        delphiProperty("Scale", delphiFloat64(2.5)),
      ]),
    ),
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects a property name range outside its owning property", async () => {
  const report = await observedReport();
  const index = report.resources.findIndex(
    (resource) => resource.type.kind === "id" && resource.type.id === 10,
  );
  const resource = report.resources[index]!;
  const payload = resource.payload.location;
  const pages = codePageFields(resource.code_page);
  const location = rootAfterSignature(payload);
  report.delphi_forms = [
    {
      resource_index: index,
      signature: "TPF0",
      version: "boVersion0",
      signature_location: signatureAt(payload),
      prefix: null,
      ...pages,
      root: {
        ...validRoot(location),
        properties: [
          {
            name: {
              text: "Caption",
              bytes_hex: "43617074696f6e",
              code_page: pages.code_page,
              location: { offset: payload.offset, bytes: 8 },
            },
            value_type: "vaNull",
            value: { kind: "null", location },
            location,
          },
        ],
      },
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("publishes a decoded form that stopped with an explicit unknown", async () => {
  const payload = delphiForm(
    delphiComponent("TForm1", "Form1", [
      delphiProperty("Future", delphiBytes(24, 1, 2, 3)),
    ]),
  );
  const { bytes } = peResourceFixture(false, [
    { type: 10, name: 7, language: 1033, payload },
  ]);
  const report = await parsePeResources(
    bytes,
    {
      path: "/fixtures/example.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({ path: "/fixtures/example.exe" }),
  );
  expect(report.delphi_forms[0]?.root.unknown?.reason).toContain(
    "Unsupported value type",
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("publishes a nested child that stopped with an explicit unknown", async () => {
  const payload = delphiForm(
    delphiComponent("TForm1", "Form1", [], {
      children: [
        delphiComponent("TButton", "Button1", [
          delphiProperty("Future", delphiBytes(24, 1, 2, 3)),
        ]),
      ],
    }),
  );
  const { bytes } = peResourceFixture(false, [
    { type: 10, name: 7, language: 1033, payload },
  ]);
  const report = await parsePeResources(
    bytes,
    {
      path: "/fixtures/example.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({ path: "/fixtures/example.exe" }),
  );
  expect(report.delphi_forms[0]?.root.children[0]?.unknown?.reason).toContain(
    "Unsupported value type",
  );
  expect(await inspectReport(report)).toMatchObject({ ok: true });
});

it("rejects a complete root that stops before the payload end", async () => {
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
      root: validRoot({
        offset: signatureAt(resource.payload.location).offset + 4,
        bytes: 0,
      }),
    },
  ];
  expect(await inspectReport(report)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
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
