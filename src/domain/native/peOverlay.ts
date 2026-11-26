import { z } from "zod";

import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { knownCoverage } from "../coverageAccumulator.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimit,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";
import { malformedInput, truncatedInput } from "../parseFailure.js";
import { peHeaderAnomaliesSchema } from "./peHeaderAnomalies.js";
import {
  admitPeSecurityDirectory,
  PE_SECURITY_DIRECTORY_DEFECTS,
  type PeSecurityDirectoryDefect,
  type PeSecurityDirectoryEntry,
} from "../pe/peSecurityDirectory.js";

const peSecurityDirectoryDefects = Object.keys(
  PE_SECURITY_DIRECTORY_DEFECTS,
) as PeSecurityDirectoryDefect[];

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_PE_OVERLAY_FILE_BYTES = 536870912;

/** `max_file_bytes` of `inspect_pe_overlay`. */
export const PE_OVERLAY_FILE_BYTES = {
  minimum: 64,
  maximum: MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
  default_value: 67_108_864,
  unit: "bytes",
} as const satisfies ParameterBudget;

/** The `max_file_bytes` control that refused an image. */
export const peOverlayFileLimit = (
  effectiveValue: number,
): AnalysisParameterLimit =>
  parameterBudgetLimit("max_file_bytes", PE_OVERLAY_FILE_BYTES, effectiveValue);
/**
 * Windows loader file mapping rounds PointerToRawData down to this modulus.
 * The value is 512 bytes, not the image's FileAlignment.
 */
export const PE_OVERLAY_RAW_ALIGNMENT = 0x200 as const;
const IMAGE_SCN_CNT_CODE = 0x00000020;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
/** IMAGE_SCN_CNT_UNINITIALIZED_DATA. */
export const IMAGE_SCN_CNT_UNINITIALIZED_DATA = 0x00000080;
/** Fixed entropy sample taken from the start of each non-certificate range. */
export const PE_OVERLAY_ENTROPY_WINDOW_BYTES = 4096 as const;
/** Leading bytes kept as hex on each non-certificate range. */
export const PE_OVERLAY_PREFIX_BYTES = 16 as const;
/**
 * Section rows returned inline. The PE format documents 96 as the Windows
 * loader's section limit; NumberOfSections itself can declare 65,535. Every
 * declared section still counts toward the image end.
 */
export const PE_OVERLAY_MAX_REPORTED_SECTIONS = 96 as const;

/** Limitation added when the section inventory stops at the row budget. */
export const peOverlaySectionBudgetLimitation = (declared: number): string =>
  `The image declares ${String(declared)} sections; only the first ${String(PE_OVERLAY_MAX_REPORTED_SECTIONS)} are listed. Every declared section counts toward the image end.`;

/**
 * Leading formats an existing recognizer can name. Markers such as 7z, CAB,
 * NSIS, and Inno stay `unrecognized` because no probe names them.
 */
export const PE_OVERLAY_LEADING_FORMATS = [
  "unrecognized",
  "ines",
  "nds",
  "zip",
  "godot-pck",
  "unityfs",
  "wxapkg",
  "uimage",
  "nso",
  "nro",
  "android-boot-image",
  "android-ota-payload",
  "android-vbmeta",
  "android-sparse-image",
  "ubi-image",
  "intel-hex",
  "srec",
  "uf2",
  "dfuse",
  "bflt",
  "esp-image",
  "fit",
  "qualcomm-mbn",
  "ntfs-mft",
  "plist",
  "tar",
  "dds",
  "glb",
  "ktx",
  "ktx2",
  "sqlite",
  "windows-shortcut",
  "python-pyc",
  "devicetree",
  "deb",
] as const;
export type PeOverlayLeadingFormat =
  (typeof PE_OVERLAY_LEADING_FORMATS)[number];

/** Limits that apply to every successful overlay report. */
export const PE_OVERLAY_LIMITATIONS = [
  "This inspection does not identify packers and does not claim that an overlay is a packed payload.",
  "This inspection does not verify Authenticode signatures, certificate chains, or digest coverage.",
  "Bytes inside the mapped image, including section slack between virtual size and raw size, are not reported as an overlay. Appended data can hide there.",
  "Matching nonzero SectionAlignment and FileAlignment below 512 bytes preserve raw pointers. Other images use 512-byte downward rounding.",
] as const;

/**
 * Added after {@link PE_OVERLAY_LIMITATIONS} when the security directory fails
 * the checks the certificate parser applies. Its bytes stay ordinary ranges.
 */
export const PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS: Readonly<
  Record<PeSecurityDirectoryDefect, string>
> = Object.fromEntries(
  Object.entries(PE_SECURITY_DIRECTORY_DEFECTS).map(([defect, message]) => [
    defect,
    `IMAGE_DIRECTORY_ENTRY_SECURITY is malformed: ${message} No certificate table is separated; its bytes are reported as ordinary ranges.`,
  ]),
) as Record<PeSecurityDirectoryDefect, string>;

/**
 * Added after {@link PE_OVERLAY_LIMITATIONS} when a security directory that
 * passes the shared certificate-table checks starts inside the image and ends
 * in the overlay. The image end and overlay span still hold; only the
 * classification of the trailing bytes is uncertain.
 */
export const PE_OVERLAY_STRADDLING_SECURITY_LIMITATION =
  "IMAGE_DIRECTORY_ENTRY_SECURITY starts inside the PE image and ends in the overlay. No certificate table is separated; the overlay bytes are reported as ordinary ranges." as const;

/** Complete bounded inspection of bytes appended after one PE image. */
export const inspectPeOverlayInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a PE image",
  ),
  max_file_bytes: parameterBudgetSchema(PE_OVERLAY_FILE_BYTES).describe(
    "Maximum stable artifact bytes to read (default 64 MiB)",
  ),
});
export type InspectPeOverlayInput = z.infer<typeof inspectPeOverlayInputSchema>;

const sectionSchema = z.strictObject({
  index: z.number().int().min(0).max(0xffff),
  name: z.string().max(8),
  pointer_to_raw_data: uint,
  rounded_pointer_to_raw_data: uint,
  size_of_raw_data: uint,
  characteristics: uint,
  /** True when rounding changed PointerToRawData. */
  raw_pointer_rounded: z.boolean(),
  /** False for zero-size and purely uninitialized sections; they do not move image end. */
  extends_image: z.boolean(),
});

const entropySummarySchema = z.strictObject({
  window_bytes: z.literal(PE_OVERLAY_ENTROPY_WINDOW_BYTES),
  sampled_bytes: z.number().int().min(1).max(PE_OVERLAY_ENTROPY_WINDOW_BYTES),
  shannon_bits: z.number().min(0).max(8),
});

const certificateRangeSchema = z.strictObject({
  role: z.literal("certificate_table"),
  offset: uint,
  size: z.number().int().min(1).max(0xffffffff),
});

const otherRangeSchema = z.strictObject({
  role: z.literal("other"),
  offset: uint,
  size: z.number().int().min(1).max(0xffffffff),
  sha256: digestSchema,
  entropy: entropySummarySchema,
  prefix_hex: z.string().regex(/^(?:[0-9a-f]{2}){1,16}$/u),
  leading_format: z.enum(PE_OVERLAY_LEADING_FORMATS),
});

const rangeSchema = z.discriminatedUnion("role", [
  certificateRangeSchema,
  otherRangeSchema,
]);

/** Where the PE image ends on disk and which bytes follow it. */
const peOverlayObjectSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["pe32", "pe32-plus"]),
  machine: uint,
  size_of_headers: uint,
  image_end: uint,
  file_size: uint,
  /** False when no byte follows the image end. */
  present: z.boolean(),
  raw_pointer_rounding: z.strictObject({
    alignment: z.union([z.literal(1), z.literal(PE_OVERLAY_RAW_ALIGNMENT)]),
    direction: z.literal("down"),
  }),
  sections: z.array(sectionSchema).max(PE_OVERLAY_MAX_REPORTED_SECTIONS),
  /** Partial when NumberOfSections exceeds the inline row budget. */
  section_coverage: z.strictObject({
    status: knownCoverageStatusSchema,
    declared: z.number().int().min(0).max(0xffff),
    reported: z.number().int().min(0).max(PE_OVERLAY_MAX_REPORTED_SECTIONS),
  }),
  security_directory: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("absent") }),
    z.strictObject({ status: z.literal("table"), offset: uint, size: uint }),
    z.strictObject({
      status: z.literal("malformed"),
      offset: uint,
      size: uint,
      defect: z.enum(peSecurityDirectoryDefects),
    }),
  ]),
  ranges: z.array(rangeSchema).max(3),
  header_anomalies: peHeaderAnomaliesSchema.optional(),
  limitations: z.array(z.string().min(1)),
});
export type PeOverlay = z.infer<typeof peOverlayObjectSchema>;
export type PeOverlayRange = PeOverlay["ranges"][number];

/** One COFF section the overlay calculation may extend or only list. */
export interface PeOverlaySectionInput {
  readonly index: number;
  readonly name: string;
  readonly pointerToRawData: number;
  readonly sizeOfRawData: number;
  readonly characteristics: number;
}

/**
 * Declared header facts the image-end calculation needs. `sections` is
 * consumed once, in table order, so a parser can stream the section table
 * without retaining a record per declared section.
 */
export interface PeOverlayHeaderFacts {
  readonly sizeOfHeaders: number;
  readonly sectionAlignment: number;
  readonly fileAlignment: number;
  readonly sections: Iterable<PeOverlaySectionInput>;
}

/** Ranges before hashes, entropy, and leading-format samples are attached. */
export interface PeOverlayLayoutRange {
  readonly role: "certificate_table" | "other";
  readonly offset: number;
  readonly size: number;
}

/** Image end and overlay spans. Byte samples stay with the parser. */
export interface PeOverlayLayout {
  readonly size_of_headers: number;
  readonly raw_pointer_rounding: PeOverlay["raw_pointer_rounding"];
  readonly image_end: number;
  readonly file_size: number;
  readonly present: boolean;
  readonly sections: PeOverlay["sections"];
  readonly section_coverage: PeOverlay["section_coverage"];
  readonly security_directory: PeOverlay["security_directory"];
  readonly ranges: readonly PeOverlayLayoutRange[];
  readonly limitations: readonly string[];
}

const uint32 = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

/** Round a section raw pointer down the way the Windows loader maps files. */
const roundPeRawPointer = (pointer: number, alignment: number): number =>
  pointer - (pointer % alignment);

/**
 * A section extends the on-disk image only when it has raw bytes and is not
 * marked as uninitialized data alone among the content flags.
 */
const peSectionExtendsImage = (
  sizeOfRawData: number,
  characteristics: number,
): boolean =>
  sizeOfRawData > 0 &&
  ((characteristics & IMAGE_SCN_CNT_UNINITIALIZED_DATA) === 0 ||
    (characteristics &
      (IMAGE_SCN_CNT_CODE | IMAGE_SCN_CNT_INITIALIZED_DATA)) !==
      0);

const sectionDiskLayout = (
  pointer: number,
  size: number,
  characteristics: number,
  alignment: number,
) => {
  const rounded = roundPeRawPointer(pointer, alignment);
  const extendsImage = peSectionExtendsImage(size, characteristics);
  return {
    end: extendsImage ? pointer + size : 0,
    fields: {
      rounded_pointer_to_raw_data: rounded,
      raw_pointer_rounded: rounded !== pointer,
      extends_image: extendsImage,
    },
  };
};

/** A section's declared raw range must fit the file if it bounds the image end. */
const admitSection = (
  section: PeOverlaySectionInput,
  fileSize: number,
  end: number,
): void => {
  if (
    !uint32(section.pointerToRawData) ||
    !uint32(section.sizeOfRawData) ||
    !uint32(section.characteristics) ||
    !Number.isInteger(section.index) ||
    section.index < 0
  )
    throw malformedInput(
      "pe",
      `PE section index ${String(section.index)} has a raw field that is not a file dword.`,
      { field: `section[${String(section.index)}]` },
    );
  if (end > fileSize)
    throw truncatedInput(
      "pe",
      `PE section index ${String(section.index)} raw range ${String(section.pointerToRawData)} + ${String(section.sizeOfRawData)} leaves the artifact.`,
      {
        offset: section.pointerToRawData,
        field: `section[${String(section.index)}].PointerToRawData`,
      },
    );
};

const overlayRanges = (
  imageEnd: number,
  fileSize: number,
  table: { readonly offset: number; readonly size: number } | null,
): readonly PeOverlayLayoutRange[] => {
  const whole = (): readonly PeOverlayLayoutRange[] =>
    imageEnd === fileSize
      ? []
      : [{ role: "other", offset: imageEnd, size: fileSize - imageEnd }];
  if (table === null) return whole();
  const end = table.offset + table.size;
  // A table that sits entirely inside the mapped image is not overlay.
  if (end <= imageEnd) return whole();
  const ranges: PeOverlayLayoutRange[] = [];
  if (table.offset > imageEnd)
    ranges.push({
      role: "other",
      offset: imageEnd,
      size: table.offset - imageEnd,
    });
  ranges.push({
    role: "certificate_table",
    offset: table.offset,
    size: table.size,
  });
  if (end < fileSize)
    ranges.push({ role: "other", offset: end, size: fileSize - end });
  return ranges;
};

const peOverlayDirectoryLayout = (
  securityDirectory: PeSecurityDirectoryEntry | undefined,
  sizeOfHeaders: number,
  imageEnd: number,
  fileSize: number,
) => {
  const security = admitPeSecurityDirectory(
    securityDirectory,
    sizeOfHeaders,
    fileSize,
  );
  // The section scan fixed the image end; a table across it only leaves the
  // trailing bytes unclassified.
  const straddles =
    security.status === "table" &&
    security.offset < imageEnd &&
    security.offset + security.size > imageEnd;
  return {
    security_directory: security,
    ranges: overlayRanges(
      imageEnd,
      fileSize,
      security.status === "table" && !straddles ? security : null,
    ),
    straddles,
  };
};

/**
 * Image end is the maximum of SizeOfHeaders and each contributing section's
 * declared PointerToRawData plus SizeOfRawData. The loader-rounded pointer is
 * recorded per section but never shortens that end, so bytes a section
 * declares are not reported as appended. The overlay is the half-open
 * span from that end to the file size, split when the certificate table lies
 * inside it. A security directory that fails the shared certificate-table
 * checks, or that starts inside the image and ends in the overlay, adds a
 * limitation and leaves its bytes in ordinary ranges.
 */
export const computePeOverlay = (
  headers: PeOverlayHeaderFacts,
  fileSize: number,
  securityDirectory: PeSecurityDirectoryEntry | undefined,
): PeOverlayLayout => {
  if (!uint32(fileSize))
    throw malformedInput("pe", "PE file size is not a byte count.");
  if (!uint32(headers.sizeOfHeaders) || headers.sizeOfHeaders > fileSize)
    throw truncatedInput("pe", "PE SizeOfHeaders leaves the artifact.", {
      field: "SizeOfHeaders",
    });
  // Every section is checked and moves the image end; only the first
  // PE_OVERLAY_MAX_REPORTED_SECTIONS are retained as report rows.
  const sections: PeOverlay["sections"][number][] = [];
  const alignment =
    headers.fileAlignment > 0 &&
    headers.fileAlignment < PE_OVERLAY_RAW_ALIGNMENT &&
    headers.sectionAlignment === headers.fileAlignment
      ? 1
      : PE_OVERLAY_RAW_ALIGNMENT;
  let imageEnd = headers.sizeOfHeaders;
  let declared = 0;
  for (const section of headers.sections) {
    declared += 1;
    const { end, fields } = sectionDiskLayout(
      section.pointerToRawData,
      section.sizeOfRawData,
      section.characteristics,
      alignment,
    );
    admitSection(section, fileSize, end);
    if (sections.length < PE_OVERLAY_MAX_REPORTED_SECTIONS)
      sections.push({
        index: section.index,
        name: section.name,
        pointer_to_raw_data: section.pointerToRawData,
        size_of_raw_data: section.sizeOfRawData,
        characteristics: section.characteristics,
        ...fields,
      });
    imageEnd = Math.max(imageEnd, end);
  }
  const partial = declared > sections.length;
  const coverage: PeOverlay["section_coverage"] = {
    status: knownCoverage(
      !partial,
      "section inventory truncated at inline row budget",
    ),
    declared,
    reported: sections.length,
  };
  const { security_directory, ranges, straddles } = peOverlayDirectoryLayout(
    securityDirectory,
    headers.sizeOfHeaders,
    imageEnd,
    fileSize,
  );
  return {
    size_of_headers: headers.sizeOfHeaders,
    raw_pointer_rounding: { alignment, direction: "down" },
    image_end: imageEnd,
    file_size: fileSize,
    present: imageEnd < fileSize,
    sections,
    section_coverage: coverage,
    security_directory,
    ranges,
    limitations: [
      ...PE_OVERLAY_LIMITATIONS,
      ...(security_directory.status === "malformed"
        ? [PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS[security_directory.defect]]
        : []),
      ...(straddles ? [PE_OVERLAY_STRADDLING_SECURITY_LIMITATION] : []),
      ...(partial ? [peOverlaySectionBudgetLimitation(declared)] : []),
    ],
  };
};

/** Complete coverage lists every section; partial lists exactly the budget. */
const coverageMatches = ({ sections, section_coverage }: PeOverlay): boolean =>
  section_coverage.reported === sections.length &&
  (section_coverage.status === "complete"
    ? section_coverage.declared === sections.length
    : sections.length === PE_OVERLAY_MAX_REPORTED_SECTIONS &&
      section_coverage.declared > sections.length);

const sectionsMatch = (report: PeOverlay): boolean => {
  if (!coverageMatches(report)) return false;
  let imageEnd = report.size_of_headers;
  for (const [index, section] of report.sections.entries()) {
    const { end, fields } = sectionDiskLayout(
      section.pointer_to_raw_data,
      section.size_of_raw_data,
      section.characteristics,
      report.raw_pointer_rounding.alignment,
    );
    if (
      section.index !== index ||
      section.rounded_pointer_to_raw_data !==
        fields.rounded_pointer_to_raw_data ||
      section.raw_pointer_rounded !== fields.raw_pointer_rounded ||
      section.extends_image !== fields.extends_image
    )
      return false;
    imageEnd = Math.max(imageEnd, end);
  }
  // Unlisted sections may still move the image end past the listed ones.
  const endMatches =
    report.section_coverage.status === "complete"
      ? imageEnd === report.image_end
      : imageEnd <= report.image_end;
  return endMatches && report.image_end >= report.size_of_headers;
};

const directoryLayoutMatches = (report: PeOverlay): boolean => {
  const directory = report.security_directory;
  const expected = peOverlayDirectoryLayout(
    directory.status === "absent"
      ? undefined
      : { address: directory.offset, size: directory.size },
    report.size_of_headers,
    report.image_end,
    report.file_size,
  );
  if (
    directory.status !== expected.security_directory.status ||
    (directory.status === "malformed" &&
      expected.security_directory.status === "malformed" &&
      directory.defect !== expected.security_directory.defect) ||
    report.ranges.length !== expected.ranges.length
  )
    return false;
  for (const [index, range] of report.ranges.entries()) {
    const span = expected.ranges[index];
    if (
      !span ||
      range.role !== span.role ||
      range.offset !== span.offset ||
      range.size !== span.size
    )
      return false;
    if (range.role === "other") {
      const sampled = Math.min(range.size, PE_OVERLAY_ENTROPY_WINDOW_BYTES);
      const prefixBytes = Math.min(range.size, PE_OVERLAY_PREFIX_BYTES);
      if (
        range.entropy.sampled_bytes !== sampled ||
        range.prefix_hex.length !== prefixBytes * 2
      )
        return false;
    }
  }
  return true;
};

/** Validate structured layout invariants while preserving the provider's diagnostics. */
export const peOverlaySchema = peOverlayObjectSchema.refine(
  (report) =>
    report.file_size === report.artifact.bytes &&
    report.size_of_headers <= report.file_size &&
    report.image_end <= report.file_size &&
    report.present === report.image_end < report.file_size &&
    sectionsMatch(report) &&
    directoryLayoutMatches(report),
  "PE overlay layout is inconsistent with its reported headers or artifact extent.",
);
