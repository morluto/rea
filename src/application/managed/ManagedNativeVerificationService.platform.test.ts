import { expect, it } from "vitest";

import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../contracts/managed/managedWorkflowExamples.js";
import { createEvidence } from "../../domain/evidence.js";
import { managedNativeBoundaryInspectionSchema } from "../../domain/managed/managedArtifact.js";
import { managedNativeVerificationResultSchema } from "../../domain/managed/managedNativeVerificationSchemas.js";
import { functionDossierSchema } from "../../domain/native/functionDossier.js";
import { inspectMachoSchema } from "../../domain/native/nativeInspection.js";
import { executeManagedNativeBoundaries } from "./ManagedNativeVerificationService.js";

type NativeFormat = "mach-o" | "mach-o-universal" | "pe" | "elf" | "file";
const native = (format: NativeFormat, path: string, decorated: boolean) => {
  const original = MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0]!;
  const name = decorated ? "open_nativeW" : "open_native";
  const symbolTableName = `_${name}`;
  const macho = inspectMachoSchema.parse(original.normalized_result);
  const isMacho = format === "mach-o" || format === "mach-o-universal";
  const result = isMacho
    ? {
        ...macho,
        format,
        exports: {
          ...macho.exports,
          total: 1,
          items: [
            {
              name: symbolTableName,
              address: "0x1000",
              weak: false,
              reexport: false,
              source: "nm",
            },
          ],
        },
      }
    : functionDossierSchema.parse({
        procedure: {
          address: "0x1000",
          name,
          classification: {
            external: false,
            thunk: false,
            thunk_target: null,
            provenance: "synthetic-provider",
          },
          body: { available: false, reason: "Inert authored observation" },
          signature: null,
          locals: [],
        },
        pseudocode: "",
        assembly: [],
        comments: [],
        callers: [],
        callees: [],
        incoming_references: [],
        outgoing_references: [],
        referenced_strings: [],
        referenced_names: [],
        basic_blocks: [],
        native_api: null,
        native_value_flow: null,
        limitations: [],
      });
  return createEvidence(
    { path, sha256: "a".repeat(64), format },
    original.provider,
    {
      operation: isMacho ? "inspect_macho" : "analyze_function",
      parameters: {},
      result,
    },
  );
};

const verify = (
  format: NativeFormat,
  path: string,
  scope: string,
  decorated = false,
) => {
  const original = MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries;
  const managed = managedNativeBoundaryInspectionSchema.parse(
    original.normalized_result,
  );
  const managedEvidence = createEvidence(undefined, original.provider, {
    operation: original.operation,
    parameters: {},
    result: {
      ...managed,
      pinvoke_imports: managed.pinvoke_imports.map((item) => ({
        ...item,
        import_scope_name: scope,
        no_mangle: !decorated,
        char_set: decorated ? "unicode" : "not-specified",
        call_convention: "cdecl",
      })),
    },
  });
  const nativeEvidence = native(format, path, decorated);
  const execution = executeManagedNativeBoundaries({
    managed_boundaries: managedEvidence,
    native_observations: [nativeEvidence],
  });
  if (!execution.ok) throw execution.error;
  expect(execution.value.sourceEvidence).toEqual([
    managedEvidence,
    nativeEvidence,
  ]);
  expect(execution.value.sourceEvidence[1]?.subject?.format).toBe(format);
  const result = managedNativeVerificationResultSchema.parse(
    execution.value.evidence.normalized_result,
  );
  expect(result.evidence_links).toEqual([
    managedEvidence.evidence_id,
    nativeEvidence.evidence_id,
  ]);
  const item = result.pinvoke_imports[0]!;
  expect(item.managed.import_scope_name).toBe(scope);
  return { item, execution: execution.value, nativeEvidence };
};

it.each([
  {
    format: "mach-o",
    path: "/fixtures/libnativehelper.dylib",
    status: "verified",
  },
  {
    format: "mach-o-universal",
    path: "/fixtures/libnativehelper.dylib",
    status: "verified",
  },
  { format: "elf", path: "/fixtures/libnativehelper.so", status: "verified" },
  { format: "pe", path: "C:\\fixtures\\nativehelper.dll", status: "verified" },
  {
    format: "file",
    path: "/fixtures/libnativehelper.dylib",
    status: "unresolved",
  },
] as const)(
  "uses authenticated $format subject platform for module aliases",
  ({ format, path, status }) => {
    const { item, execution, nativeEvidence } = verify(
      format,
      path,
      "nativehelper",
    );
    expect(item.status).toBe(status);
    expect(execution.hasUnknowns).toBe(format === "file");
    expect(item.matched_native?.evidence_id).toBe(nativeEvidence.evidence_id);
    expect(item.matched_native?.name).toBe(
      format === "mach-o" || format === "mach-o-universal"
        ? "_open_native"
        : "open_native",
    );
    if (format === "file") expect(item.basis).toBe("module-identity-unknown");
  },
);

it.each([
  {
    format: "mach-o",
    path: "/fixtures/libnativehelper.dylib",
    scope: "libnativehelper.dylib",
    status: "unresolved",
  },
  {
    format: "mach-o-universal",
    path: "/fixtures/libnativehelper.dylib",
    scope: "libnativehelper.dylib",
    status: "unresolved",
  },
  {
    format: "elf",
    path: "/fixtures/libnativehelper.so",
    scope: "libnativehelper.so",
    status: "unresolved",
  },
  {
    format: "pe",
    path: "C:\\fixtures\\nativehelper.dll",
    scope: "nativehelper.dll",
    status: "inferred",
  },
  {
    format: "file",
    path: "/fixtures/nativehelper",
    scope: "nativehelper",
    status: "inferred",
  },
] as const)(
  "keeps Windows decorated-name candidates within $format platform authority",
  ({ format, path, scope, status }) => {
    const { item } = verify(format, path, scope, true);
    expect(item.status).toBe(status);
    if (status === "unresolved") {
      expect(item.basis).toBe("no-native-candidate");
      expect(item.candidates).toEqual([]);
    } else expect(item.basis).toBe("decorated-name-candidate");
  },
);
