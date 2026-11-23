import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { KernelModulePort } from "../../ports/binaryDiagnostics/KernelModulePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
  KERNEL_MODULE_VERSION_ENTRY_BYTES,
  MAX_KERNEL_MODULE_RAW_BYTES,
  MODULE_SIGNATURE_INFO_BYTES,
  MODULE_SIGNATURE_MAGIC,
  MODULE_SIGNATURE_PKCS7_ID_TYPE,
  type KernelModule,
  type InspectKernelModuleInput,
} from "../../domain/native/kernelModule.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_kernel_module";

type Range = { readonly offset: number; readonly bytes: number };

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class KernelModuleService {
  constructor(readonly provider: KernelModulePort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectKernelModuleInputSchema,
        outputSchema: kernelModuleSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Kernel module provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) => {
          const architecture =
            value.machine === null ? undefined : elfArchitecture(value.machine);
          const locations = [
            { kind: "artifact-path" as const, path: value.artifact.path },
            ...rangesOf(value).map((range) => ({
              kind: "file-offset-range" as const,
              start: range.offset,
              end: range.offset + range.bytes,
            })),
          ];
          return createEvidence(
            {
              path: value.artifact.path,
              format: value.applicability === "unsupported" ? "file" : "elf",
              sha256: value.artifact.sha256,
              ...(architecture === undefined ? {} : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations,
            },
          );
        },
      },
      rawInput,
      options,
    );
  }
}

const rangesOf = (report: KernelModule): Range[] => {
  const found: Range[] = [];
  const add = (range: Range | null | undefined): void => {
    if (range !== null && range !== undefined) found.push(range);
  };
  add(report.modinfo?.location);
  for (const entry of report.modinfo?.entries ?? []) add(entry.location);
  add(report.versions?.location);
  for (const entry of report.versions?.entries ?? []) add(entry.location);
  add(report.this_module?.location);
  add(report.init_text?.location);
  add(report.exit_text?.location);
  for (const section of report.ksymtab?.sections ?? []) add(section.location);
  add(report.signature?.magic);
  add(report.signature?.info?.location);
  add(report.signature?.pkcs7?.location);
  return found;
};

const modinfoConsistent = (
  modinfo: NonNullable<KernelModule["modinfo"]>,
  input: InspectKernelModuleInput,
): boolean => {
  const closed =
    modinfo.status === "malformed" || modinfo.status === "unsupported";
  if (closed) {
    if (modinfo.reason === null || modinfo.entries.length !== 0) return false;
  } else if (modinfo.reason !== null) return false;
  if (modinfo.status === "absent" || modinfo.status === "unknown") {
    if (
      modinfo.location !== null ||
      modinfo.sha256 !== null ||
      modinfo.entries.length !== 0
    )
      return false;
  }
  if (
    modinfo.status === "present" &&
    (modinfo.location === null || modinfo.sha256 === null)
  )
    return false;
  return modinfo.entries.every((entry, index) => {
    if (entry.index !== index) return false;
    if (new Set(entry.omitted_fields).size !== entry.omitted_fields.length)
      return false;
    for (const field of ["key", "value"] as const) {
      const text = entry[field];
      if (entry.omitted_fields.includes(field) && text !== null) return false;
      const maximum =
        field === "key"
          ? input.max_modinfo_key_bytes
          : input.max_modinfo_value_bytes;
      if (text !== null && text.length > maximum) return false;
    }
    const rawFits = entry.location.bytes <= MAX_KERNEL_MODULE_RAW_BYTES;
    if (rawFits) {
      if (
        entry.raw_hex === null ||
        entry.raw_hex.length !== entry.location.bytes * 2
      )
        return false;
    } else if (entry.raw_hex !== null) return false;
    if (entry.status === "observed")
      return (
        entry.reason === null &&
        (entry.key !== null || entry.omitted_fields.includes("key")) &&
        (entry.value !== null || entry.omitted_fields.includes("value"))
      );
    return entry.reason !== null;
  });
};

const versionsConsistent = (
  versions: NonNullable<KernelModule["versions"]>,
): boolean => {
  if (
    versions.layout === null ||
    versions.entry_bytes !== KERNEL_MODULE_VERSION_ENTRY_BYTES
  )
    return false;
  const closed =
    versions.status === "malformed" || versions.status === "unsupported";
  if (closed) {
    if (versions.reason === null || versions.entries.length !== 0) return false;
  } else if (versions.reason !== null) return false;
  if (versions.status === "absent" || versions.status === "unknown") {
    if (
      versions.location !== null ||
      versions.sha256 !== null ||
      versions.entries.length !== 0
    )
      return false;
  }
  if (
    versions.status === "present" &&
    (versions.location === null || versions.sha256 === null)
  )
    return false;
  const width = versions.layout === "elf64_unsigned_long_name56" ? 16 : 8;
  return versions.entries.every((entry, index) => {
    if (entry.index !== index || entry.crc_hex.length !== width) return false;
    if (entry.location.bytes !== KERNEL_MODULE_VERSION_ENTRY_BYTES)
      return false;
    if (entry.status === "observed")
      return entry.reason === null && entry.name !== null;
    return entry.reason !== null && entry.name === null;
  });
};

const signatureConsistent = (
  signature: NonNullable<KernelModule["signature"]>,
  fileBytes: number,
): boolean => {
  if (signature.status === "absent")
    return (
      signature.reason === null &&
      signature.magic === null &&
      signature.info === null &&
      signature.pkcs7 === null
    );
  if (
    signature.magic === null ||
    signature.magic.bytes !== MODULE_SIGNATURE_MAGIC.length ||
    signature.magic.offset !== fileBytes - MODULE_SIGNATURE_MAGIC.length
  )
    return false;
  if (signature.status === "present") {
    const info = signature.info;
    const pkcs7 = signature.pkcs7;
    if (signature.reason !== null || info === null || pkcs7 === null)
      return false;
    return (
      info.id_type === MODULE_SIGNATURE_PKCS7_ID_TYPE &&
      info.algo === 0 &&
      info.hash === 0 &&
      info.signer_len === 0 &&
      info.key_id_len === 0 &&
      info.pad.every((value) => value === 0) &&
      info.sig_len > 0 &&
      info.sig_len === pkcs7.location.bytes &&
      pkcs7.location.offset + pkcs7.location.bytes === info.location.offset &&
      signature.magic.offset === info.location.offset + info.location.bytes &&
      info.location.bytes === MODULE_SIGNATURE_INFO_BYTES &&
      info.sig_len < info.location.offset
    );
  }
  if (signature.pkcs7 !== null || signature.reason === null) return false;
  if (signature.status === "unsupported")
    return (
      signature.reason === "signature_id_type_not_pkcs7" &&
      signature.info !== null
    );
  return signature.reason === "signature_trailer_truncated"
    ? signature.info === null
    : signature.info !== null;
};

const sizedConsistent = (
  section: NonNullable<KernelModule["init_text"]>,
): boolean => {
  if (section.status === "absent" || section.status === "unknown")
    return (
      section.location === null &&
      section.bytes === null &&
      section.compressed === null
    );
  if (section.location === null) return section.bytes === null;
  return (
    section.bytes === section.location.bytes && section.compressed !== null
  );
};

const metadataAbsent = (report: KernelModule): boolean =>
  report.modinfo === null &&
  report.versions === null &&
  report.this_module === null &&
  report.ksymtab === null &&
  report.init_text === null &&
  report.exit_text === null &&
  report.signature === null;

const validReport = (
  report: KernelModule,
  input: InspectKernelModuleInput,
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.coverage.examined_entries > input.max_entries ||
    !rangesOf(report).every(insideArtifact(report.artifact.bytes))
  )
    return false;
  if (report.applicability === "unsupported")
    return (
      report.coverage.status === "unsupported" &&
      report.coverage.examined_entries === 0 &&
      report.compression !== null &&
      report.next_probe?.operation === "external_decompression" &&
      report.format === null &&
      report.byte_order === null &&
      report.machine === null &&
      report.type === null &&
      report.type_name === null &&
      metadataAbsent(report)
    );
  if (
    report.format === null ||
    report.byte_order === null ||
    report.machine === null ||
    report.type === null ||
    report.type_name !== elfObjectTypeName(report.type) ||
    report.compression !== null ||
    report.next_probe !== null
  )
    return false;
  if (report.applicability === "not_applicable")
    return (
      report.coverage.status === "not_applicable" &&
      report.coverage.examined_entries === 0 &&
      report.type !== 1 &&
      metadataAbsent(report)
    );
  if (report.applicability !== "applicable") return false;
  if (
    (report.coverage.status !== "complete" &&
      report.coverage.status !== "partial") ||
    report.modinfo === null ||
    report.versions === null ||
    report.this_module === null ||
    report.this_module.layout !== "unknown" ||
    report.ksymtab === null ||
    report.init_text === null ||
    report.exit_text === null ||
    report.signature === null
  )
    return false;
  if (
    report.coverage.examined_entries !==
    report.modinfo.entries.length +
      report.versions.entries.length +
      report.ksymtab.sections.length
  )
    return false;
  if (
    !report.ksymtab.sections.every(
      (section) => (section.name === null) === (section.reason !== null),
    )
  )
    return false;
  if (report.type !== 1) return false;
  return (
    modinfoConsistent(report.modinfo, input) &&
    versionsConsistent(report.versions) &&
    signatureConsistent(report.signature, report.artifact.bytes) &&
    sizedConsistent(report.init_text) &&
    sizedConsistent(report.exit_text)
  );
};
