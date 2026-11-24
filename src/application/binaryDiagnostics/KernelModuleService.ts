import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { KernelModulePort } from "../../ports/binaryDiagnostics/KernelModulePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
  KERNEL_MODULE_CRC32_ENTRY_BYTES,
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
        retainCompletedReport: true,
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
  add(report.extended_versions?.names_section.location);
  add(report.extended_versions?.crcs_section.location);
  for (const entry of report.extended_versions?.entries ?? []) {
    add(entry.crc_location);
    add(entry.name_location);
  }
  add(report.this_module?.location);
  add(report.init_text?.location);
  add(report.exit_text?.location);
  for (const section of report.ksymtab?.sections ?? []) add(section.location);
  add(report.ksymtab?.strings?.location);
  for (const entry of report.ksymtab?.strings?.entries ?? [])
    add(entry.location);
  add(report.ksymtab?.kcrctab?.location);
  for (const entry of report.ksymtab?.kcrctab?.entries ?? [])
    add(entry.location);
  add(report.ksymtab?.kcrctab_gpl?.location);
  for (const entry of report.ksymtab?.kcrctab_gpl?.entries ?? [])
    add(entry.location);
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

const insideRange =
  (parent: Range) =>
  (child: Range): boolean => {
    if (child.offset < parent.offset) return false;
    const relativeOffset = child.offset - parent.offset;
    return (
      relativeOffset <= parent.bytes &&
      child.bytes <= parent.bytes - relativeOffset
    );
  };

const rawHexMatches = (location: Range, rawHex: string | null): boolean => {
  const rawFits = location.bytes <= MAX_KERNEL_MODULE_RAW_BYTES;
  if (rawFits) return rawHex !== null && rawHex.length === location.bytes * 2;
  return rawHex === null;
};

const ksymtabStringsConsistent = (
  strings: NonNullable<NonNullable<KernelModule["ksymtab"]>["strings"]>,
): boolean => {
  const closed =
    strings.status === "malformed" || strings.status === "unsupported";
  if (closed) {
    if (strings.reason === null || strings.entries.length !== 0) return false;
  } else if (strings.reason !== null) return false;
  if (strings.status === "absent" || strings.status === "unknown") {
    if (
      strings.location !== null ||
      strings.sha256 !== null ||
      strings.entries.length !== 0
    )
      return false;
  }
  const sectionLocation = strings.location;
  if (
    strings.status === "present" &&
    (sectionLocation === null || strings.sha256 === null)
  )
    return false;
  return strings.entries.every((entry, index) => {
    if (entry.index !== index) return false;
    if (
      sectionLocation === null ||
      !insideRange(sectionLocation)(entry.location)
    )
      return false;
    if (!rawHexMatches(entry.location, entry.raw_hex)) return false;
    if (entry.status === "observed")
      return (
        entry.reason === null &&
        (entry.omitted
          ? entry.value === null &&
            entry.location.bytes > MAX_KERNEL_MODULE_RAW_BYTES
          : entry.value !== null &&
            entry.value.length > 0 &&
            entry.value.length <= MAX_KERNEL_MODULE_RAW_BYTES)
      );
    return entry.reason !== null && entry.value === null && !entry.omitted;
  });
};

const kcrctabConsistent = (
  table: NonNullable<NonNullable<KernelModule["ksymtab"]>["kcrctab"]>,
): boolean => {
  if (table.entry_bytes !== KERNEL_MODULE_CRC32_ENTRY_BYTES) return false;
  const closed = table.status === "malformed" || table.status === "unsupported";
  if (closed) {
    if (table.reason === null || table.entries.length !== 0) return false;
  } else if (table.reason !== null) return false;
  if (table.status === "absent" || table.status === "unknown") {
    if (
      table.location !== null ||
      table.sha256 !== null ||
      table.entries.length !== 0
    )
      return false;
  }
  const tableLocation = table.location;
  if (
    table.status === "present" &&
    (tableLocation === null ||
      table.sha256 === null ||
      tableLocation.bytes !==
        table.entries.length * KERNEL_MODULE_CRC32_ENTRY_BYTES)
  )
    return false;
  return table.entries.every(
    (entry, index) =>
      entry.index === index &&
      entry.location.bytes === KERNEL_MODULE_CRC32_ENTRY_BYTES &&
      tableLocation !== null &&
      insideRange(tableLocation)(entry.location) &&
      entry.location.offset ===
        tableLocation.offset + index * KERNEL_MODULE_CRC32_ENTRY_BYTES,
  );
};

const extendedSectionMetaConsistent = (
  meta: NonNullable<KernelModule["extended_versions"]>["names_section"],
  isCrcs: boolean,
): boolean => {
  if (meta.status === "absent" || meta.status === "unknown")
    return (
      meta.location === null &&
      meta.sha256 === null &&
      meta.count === null &&
      meta.reason === null
    );
  if (meta.status === "malformed" || meta.status === "unsupported") {
    if (meta.reason === null || meta.count !== null) return false;
    const expectedNotBacked = isCrcs
      ? "version_ext_crcs_not_file_backed"
      : "version_ext_names_not_file_backed";
    const expectedCompressed = isCrcs
      ? "version_ext_crcs_compressed"
      : "version_ext_names_compressed";
    if (meta.status === "malformed") {
      if (meta.reason === expectedNotBacked)
        return meta.location === null && meta.sha256 === null;
      if (isCrcs && meta.reason === "version_ext_crcs_size_not_multiple")
        return meta.location !== null && meta.sha256 !== null;
      return false;
    }
    return (
      meta.reason === expectedCompressed &&
      meta.location !== null &&
      meta.sha256 !== null
    );
  }
  if (meta.location === null || meta.sha256 === null || meta.reason !== null)
    return false;
  if (
    isCrcs &&
    meta.count !== null &&
    meta.location.bytes !== meta.count * KERNEL_MODULE_CRC32_ENTRY_BYTES
  )
    return false;
  return true;
};

const extendedVersionsConsistent = (
  ext: NonNullable<KernelModule["extended_versions"]>,
): boolean => {
  if (ext.entry_crc_bytes !== KERNEL_MODULE_CRC32_ENTRY_BYTES) return false;
  if (
    !extendedSectionMetaConsistent(ext.names_section, false) ||
    !extendedSectionMetaConsistent(ext.crcs_section, true)
  )
    return false;
  const closed = ext.status === "malformed" || ext.status === "unsupported";
  if (closed) {
    if (ext.reason === null || ext.entries.length !== 0) return false;
  } else if (ext.reason !== null) return false;
  if (ext.status === "absent")
    return (
      ext.names_section.status === "absent" &&
      ext.crcs_section.status === "absent" &&
      ext.entries.length === 0
    );
  if (ext.status === "unknown")
    return (
      (ext.names_section.status === "unknown" ||
        ext.crcs_section.status === "unknown") &&
      ext.entries.length === 0
    );
  if (ext.status === "malformed" && ext.reason === "version_ext_names_missing")
    return (
      ext.names_section.status === "absent" &&
      ext.crcs_section.status === "present"
    );
  if (ext.status === "malformed" && ext.reason === "version_ext_crcs_missing")
    return (
      ext.crcs_section.status === "absent" &&
      ext.names_section.status === "present"
    );
  if (ext.status === "malformed" && ext.reason === "version_ext_count_mismatch")
    return (
      ext.names_section.status === "present" &&
      ext.crcs_section.status === "present" &&
      ext.names_section.count !== null &&
      ext.crcs_section.count !== null &&
      ext.names_section.count !== ext.crcs_section.count
    );
  if (ext.status !== "present") return true;
  const namesLocation = ext.names_section.location;
  const crcsLocation = ext.crcs_section.location;
  if (
    ext.names_section.status !== "present" ||
    ext.crcs_section.status !== "present" ||
    namesLocation === null ||
    crcsLocation === null ||
    ext.names_section.count !== ext.entries.length ||
    ext.crcs_section.count !== ext.entries.length ||
    crcsLocation.bytes !== ext.entries.length * KERNEL_MODULE_CRC32_ENTRY_BYTES
  )
    return false;
  return ext.entries.every((entry, index) => {
    if (
      entry.index !== index ||
      !insideRange(crcsLocation)(entry.crc_location) ||
      !insideRange(namesLocation)(entry.name_location) ||
      entry.crc_location.bytes !== KERNEL_MODULE_CRC32_ENTRY_BYTES ||
      entry.crc_location.offset !==
        crcsLocation.offset + index * KERNEL_MODULE_CRC32_ENTRY_BYTES
    )
      return false;
    if (!rawHexMatches(entry.name_location, entry.name_raw_hex)) return false;
    if (entry.status === "observed")
      return (
        entry.reason === null &&
        (entry.omitted
          ? entry.name === null &&
            entry.name_location.bytes > MAX_KERNEL_MODULE_RAW_BYTES
          : entry.name !== null &&
            entry.name.length > 0 &&
            entry.name.length <= MAX_KERNEL_MODULE_RAW_BYTES)
      );
    return entry.reason !== null && entry.name === null && !entry.omitted;
  });
};

const metadataAbsent = (report: KernelModule): boolean =>
  report.modinfo === null &&
  report.versions === null &&
  (report.extended_versions === null ||
    report.extended_versions === undefined) &&
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
    report.extended_versions === null ||
    report.this_module === null ||
    report.this_module.layout !== "unknown" ||
    report.ksymtab === null ||
    report.init_text === null ||
    report.exit_text === null ||
    report.signature === null
  )
    return false;
  const ksymtabStringEntries =
    report.ksymtab.strings === undefined
      ? 0
      : report.ksymtab.strings.entries.length;
  const kcrctabEntries =
    report.ksymtab.kcrctab === undefined
      ? 0
      : report.ksymtab.kcrctab.entries.length;
  const kcrctabGplEntries =
    report.ksymtab.kcrctab_gpl === undefined
      ? 0
      : report.ksymtab.kcrctab_gpl.entries.length;
  const extendedVersionEntries =
    report.extended_versions === undefined
      ? 0
      : report.extended_versions.entries.length;
  if (
    report.coverage.examined_entries !==
    report.modinfo.entries.length +
      report.versions.entries.length +
      report.ksymtab.sections.length +
      ksymtabStringEntries +
      kcrctabEntries +
      kcrctabGplEntries +
      extendedVersionEntries
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
    (report.extended_versions === undefined ||
      extendedVersionsConsistent(report.extended_versions)) &&
    (report.ksymtab.strings === undefined ||
      ksymtabStringsConsistent(report.ksymtab.strings)) &&
    (report.ksymtab.kcrctab === undefined ||
      kcrctabConsistent(report.ksymtab.kcrctab)) &&
    (report.ksymtab.kcrctab_gpl === undefined ||
      kcrctabConsistent(report.ksymtab.kcrctab_gpl)) &&
    signatureConsistent(report.signature, report.artifact.bytes) &&
    sizedConsistent(report.init_text) &&
    sizedConsistent(report.exit_text)
  );
};
