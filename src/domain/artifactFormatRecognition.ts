import { LABVIEW_RSRC_MAGIC } from "./labview/labviewArtifact.js";
import type { ArtifactFormatId } from "./artifactGraph.js";
import { hasAndroidBootImageMagic } from "./androidBootImageFormat.js";
import { hasAndroidDtboMagic } from "./firmware/androidDtboFormat.js";
import { hasBinaryPlistSignature } from "./apple/appleArchiveFormat.js";
import { hasDfuSePrefix, isDfuSeFile } from "./firmware/dfuse.js";
import { ESP8266_REFUSAL, recognizeEspImage } from "./firmware/espImage.js";
import { hasFitImagesNode } from "./firmware/fitImage.js";
import { detectHexRecordEncoding } from "./firmware/hexRecords.js";
import { hasUf2Block } from "./firmware/uf2.js";
import { hasGodotPckHeader } from "./godotPckFormat.js";
import { nesContainerFormat, parseInesLayout } from "./inesContainer.js";
import { type MegaDriveLayout, recognizeMegaDriveRom } from "./megaDriveRom.js";
import { n64RomRecognition } from "./n64Rom.js";
import { hasNdsHeader } from "./ndsRom.js";
import {
  hasIso9660Signature,
  ISO9660_DESCRIPTOR_OFFSET,
  ISO9660_RECOGNITION_BYTES,
} from "./iso9660/iso9660Structures.js";
import { recognizeAndroidOtaPayload } from "./firmware/androidOtaPayload.js";
import { hasAndroidVbmetaMagic } from "./firmware/androidVbmeta.js";
import { recognizeAndroidSparseImage } from "./firmware/androidSparseImage.js";
import { recognizeUbiImage } from "./firmware/ubiImage.js";
import { claimsExecutableHeader } from "./binaryTarget.js";
import { hasQualcommMbnHeader } from "./qualcommMbnImage.js";
import { hasUImageMagic } from "./uimageFormat.js";
import { hasBfltMagic } from "./bfltExecutable.js";
import { hasNroMagic, hasNsoMagic } from "./switchExecutable.js";
import { hasUnityFsHeader } from "./unityfsFormat.js";
import { hasMftFileRecordHeader } from "./windows/ntfsMft.js";
import { hasSystemdJournalHeader } from "./linux/systemdJournal.js";
import { hasAuditdLogRecord } from "./linux/auditdLog.js";
import { hasWindowsShortcutHeader } from "./windows/windowsShortcutHeader.js";
import { BinaryFormatFailure } from "./binaryContainer.js";
import {
  hasDevicetreeMagic,
  readDevicetreeHeader,
} from "./firmware/devicetreeHeader.js";
import { hasEspNvsHeader } from "./firmware/espNvsParser.js";
import { hasDebPackageHeader } from "./deb/debPackage.js";
import { observePythonBytecodePrefix } from "./python/pythonBytecodeIdentity.js";
import { hasSqliteHeader } from "./sqliteFormat.js";
import { recognizeTarPrefix, tarHeaderRefusal } from "./tarFormat.js";
import {
  hasDdsHeader,
  hasGlbHeader,
  hasKtx1Identifier,
  hasKtx2Identifier,
} from "./gpuAssetFormats.js";
import {
  hasBink2Header,
  hasOggOpusHeader,
  hasRiffXma2Header,
  hasVulkanPipelineCacheHeader,
} from "./mediaAssetFormats.js";
import { hasWxapkgEncryptedMagic, hasWxapkgHeader } from "./wxapkgFormat.js";
import { hasZipSignature } from "./zipPackageFormat.js";

/** Formats recognized from leading bytes before native executable headers. */
export type RecognizedArtifactFormat = Extract<
  ArtifactFormatId,
  | "ines"
  | "nds"
  | "mega-drive-rom"
  | "n64-rom"
  | "zip"
  | "godot-pck"
  | "unityfs"
  | "wxapkg"
  | "tar"
  | "dds"
  | "glb"
  | "ktx"
  | "ktx2"
  | "ogg-opus"
  | "riff-xma2"
  | "bink2"
  | "vulkan-pipeline-cache"
  | "uimage"
  | "nso"
  | "nro"
  | "android-boot-image"
  | "android-dtbo"
  | "android-ota-payload"
  | "android-vbmeta"
  | "android-sparse-image"
  | "ubi-image"
  | "iso9660"
  | "intel-hex"
  | "srec"
  | "uf2"
  | "dfuse"
  | "bflt"
  | "esp-flash-image"
  | "esp-image"
  | "fit"
  | "qualcomm-mbn"
  | "ntfs-mft"
  | "systemd-journal"
  | "auditd-log"
  | "plist"
  | StandaloneArtifactFormat
>;

/**
 * Single-file formats that a dedicated execution-free tool reads. Inventory
 * records only the file itself; the inspection routes it to that tool.
 */
export const STANDALONE_ARTIFACT_FORMATS = [
  "sqlite",
  "windows-shortcut",
  "python-pyc",
  "devicetree",
  "esp-nvs",
  "deb",
  "labview-rsrc",
] as const;

export type StandaloneArtifactFormat =
  (typeof STANDALONE_ARTIFACT_FORMATS)[number];

export const isStandaloneArtifactFormat = (
  format: string,
): format is StandaloneArtifactFormat =>
  (STANDALONE_ARTIFACT_FORMATS as readonly string[]).includes(format);

/** The bytes one route has read when it asks which format a file holds. */
export interface ArtifactRecognitionInput {
  /** Leading bytes; routes read different prefix lengths. */
  readonly prefix: Buffer;
  readonly fileSize: number;
  /** The final DFU suffix bytes, when the route has read them. */
  readonly suffix?: Uint8Array | undefined;
  /** Whether an ESP flash partition layout was located, when the route looked. */
  readonly espFlashLayout?: boolean | undefined;
  /**
   * The bytes at the first ISO 9660 volume descriptor (sector 16), when the
   * route has read them and the prefix does not reach them.
   */
  readonly iso9660Descriptor?: Uint8Array | undefined;
}

/**
 * What one recognizer established:
 *
 * - `recognized`: the bytes are this format.
 * - `refused`: the header names this format, but this file is one REA does
 *   not read as it (an unsupported variant or an extent that does not fit).
 * - `needs-input`: deciding needs bytes the route has not read yet.
 *
 * `index` is the recognizer's position, so a route can supply the missing
 * input or skip a refusal and resume from there.
 */
type Recognition =
  | {
      readonly state: "recognized" | "needs-input";
      readonly format: RecognizedArtifactFormat;
    }
  | {
      readonly state: "refused";
      readonly format: RecognizedArtifactFormat;
      readonly reason: string;
    };

export type ArtifactFormatRecognition = Recognition & {
  readonly index: number;
};

/** `undefined` when the bytes do not claim this recognizer's format. */
type ArtifactFormatRecognizer = (
  input: ArtifactRecognitionInput,
) => Recognition | undefined;

const when =
  (format: RecognizedArtifactFormat, claims: (prefix: Buffer) => boolean) =>
  ({ prefix }: ArtifactRecognitionInput): Recognition | undefined =>
    claims(prefix) ? { state: "recognized", format } : undefined;

/**
 * The Mega Drive layout this prefix shows. It yields to ELF, Mach-O, DOS MZ
 * and FAT, so a native header is not claimed because its bytes also match.
 */
const megaDriveLayout = (
  prefix: Buffer,
  fileSize: number,
): MegaDriveLayout | undefined =>
  claimsExecutableHeader(prefix, fileSize)
    ? undefined
    : recognizeMegaDriveRom(prefix, fileSize);
/**
 * The one ordered recognizer table. Inventory classification and binary
 * target resolution both walk it, so the same bytes reach the same verdict;
 * each route decides only what a refusal or a missing input means for it.
 */
/** A LabVIEW RSRC container starts with its own six-byte magic. */
const hasLabviewRsrcHeader = (prefix: Buffer): boolean =>
  prefix.length >= LABVIEW_RSRC_MAGIC.length &&
  prefix.subarray(0, LABVIEW_RSRC_MAGIC.length).toString("latin1") ===
    LABVIEW_RSRC_MAGIC;

export const ARTIFACT_FORMAT_RECOGNIZERS: readonly ArtifactFormatRecognizer[] =
  [
    ({ prefix, fileSize }) => {
      if (nesContainerFormat(prefix) === undefined) return undefined;
      const layout = parseInesLayout(prefix, fileSize);
      return layout.ok
        ? { state: "recognized", format: "ines" }
        : { state: "refused", format: "ines", reason: layout.error.detail };
    },
    ({ prefix, fileSize }) => {
      const claim = n64RomRecognition(prefix, fileSize);
      if (claim === undefined) return undefined;
      return claim.state === "recognized"
        ? { state: "recognized", format: "n64-rom" }
        : { state: "refused", format: "n64-rom", reason: claim.reason };
    },
    when("zip", hasZipSignature),
    when("godot-pck", hasGodotPckHeader),
    when("unityfs", hasUnityFsHeader),
    when(
      "wxapkg",
      (prefix) => hasWxapkgEncryptedMagic(prefix) || hasWxapkgHeader(prefix),
    ),
    // A ustar or GNU header, or a gzip member whose first block is one.
    ({ prefix }) => {
      if (recognizeTarPrefix(prefix) !== undefined)
        return { state: "recognized", format: "tar" };
      const reason = tarHeaderRefusal(prefix);
      return reason === undefined
        ? undefined
        : { state: "refused", format: "tar", reason };
    },
    when("dds", hasDdsHeader),
    when("glb", hasGlbHeader),
    when("ktx", hasKtx1Identifier),
    when("ktx2", hasKtx2Identifier),
    when("ogg-opus", hasOggOpusHeader),
    when("riff-xma2", hasRiffXma2Header),
    when("bink2", hasBink2Header),
    when("vulkan-pipeline-cache", hasVulkanPipelineCacheHeader),
    when("uimage", hasUImageMagic),
    when("nso", hasNsoMagic),
    when("nro", hasNroMagic),
    when("android-boot-image", hasAndroidBootImageMagic),
    when("android-dtbo", hasAndroidDtboMagic),
    when("android-vbmeta", hasAndroidVbmetaMagic),
    ({ prefix }) => {
      const ota = recognizeAndroidOtaPayload(prefix);
      if (ota === undefined) return undefined;
      return ota.state === "recognized"
        ? { state: "recognized", format: "android-ota-payload" }
        : {
            state: "refused",
            format: "android-ota-payload",
            reason: ota.reason,
          };
    },
    ({ prefix, fileSize }) => {
      const ubi = recognizeUbiImage(prefix, fileSize);
      if (ubi === undefined) return undefined;
      return ubi.state === "recognized"
        ? { state: "recognized", format: "ubi-image" }
        : { state: "refused", format: "ubi-image", reason: ubi.reason };
    },
    ({ prefix }) => {
      const sparse = recognizeAndroidSparseImage(prefix);
      if (sparse === undefined) return undefined;
      return sparse.state === "recognized"
        ? { state: "recognized", format: "android-sparse-image" }
        : {
            state: "refused",
            format: "android-sparse-image",
            reason: sparse.reason,
          };
    },
    ({ prefix }) => {
      const format = detectHexRecordEncoding(prefix);
      return format === undefined ? undefined : { state: "recognized", format };
    },
    when("uf2", hasUf2Block),
    when("bflt", hasBfltMagic),
    ({ prefix, suffix, fileSize }) => {
      if (!hasDfuSePrefix(prefix)) return undefined;
      if (suffix === undefined)
        return { state: "needs-input", format: "dfuse" };
      return isDfuSeFile(prefix, suffix, fileSize)
        ? { state: "recognized", format: "dfuse" }
        : undefined;
    },
    // The descriptor set starts at 32 KiB, past most routes' prefixes; the
    // system area before it may hold any boot code, so it claims nothing.
    ({ prefix, fileSize, iso9660Descriptor }) => {
      if (fileSize < ISO9660_RECOGNITION_BYTES) return undefined;
      const end = ISO9660_RECOGNITION_BYTES;
      const descriptor =
        iso9660Descriptor ??
        (prefix.length >= end
          ? prefix.subarray(ISO9660_DESCRIPTOR_OFFSET, end)
          : undefined);
      if (descriptor === undefined)
        return { state: "needs-input", format: "iso9660" };
      return hasIso9660Signature(descriptor)
        ? { state: "recognized", format: "iso9660" }
        : undefined;
    },
    // An SMD copier dump stores its 16 KiB block count in byte 0, so 233 or
    // 489 blocks put 0xE9 there, the ESP image magic. The ESP image has only
    // that one-byte magic and plausibility checks; an SMD dump must also carry
    // the AA BB copier mark at byte 8, the SEGA bytes its interleaving puts at
    // 640 and 641, and a size of exactly 512 bytes plus whole blocks. The
    // stronger SMD signature is therefore decided first. A plain image has
    // only SEGA at 0x100 and is decided after the leading-magic formats below.
    ({ prefix, fileSize }) =>
      megaDriveLayout(prefix, fileSize) === "smd"
        ? { state: "recognized", format: "mega-drive-rom" }
        : undefined,
    // A C3 or S3 flash dump begins with its bootloader image, so the flash
    // layout is decided before the image header.
    ({ espFlashLayout }) =>
      espFlashLayout === undefined
        ? { state: "needs-input", format: "esp-flash-image" }
        : espFlashLayout
          ? { state: "recognized", format: "esp-flash-image" }
          : undefined,
    ({ prefix, fileSize }) => {
      const esp = recognizeEspImage(prefix, fileSize);
      if (esp === undefined) return undefined;
      return esp === "esp-image"
        ? { state: "recognized", format: "esp-image" }
        : { state: "refused", format: "esp-image", reason: ESP8266_REFUSAL };
    },
    when("fit", hasFitImagesNode),
    when("ntfs-mft", hasMftFileRecordHeader),
    when("systemd-journal", hasSystemdJournalHeader),
    when("auditd-log", hasAuditdLogRecord),
    when("sqlite", hasSqliteHeader),
    when("windows-shortcut", hasWindowsShortcutHeader),
    when("deb", hasDebPackageHeader),
    ({ prefix, fileSize }) =>
      hasEspNvsHeader(prefix, fileSize)
        ? { state: "recognized", format: "esp-nvs" }
        : undefined,
    // Only a pinned CPython magic claims the format; a CR LF trailer alone
    // is too weak a signature for arbitrary bytes.
    when("python-pyc", (prefix) => {
      const observed = observePythonBytecodePrefix(prefix);
      return observed.state === "framed" && observed.identity !== null;
    }),
    // A FIT image is a devicetree too, so FIT claims it first. The header
    // owner decides whether the remaining blob is one REA reads.
    ({ prefix }) => {
      if (!hasDevicetreeMagic(prefix)) return undefined;
      try {
        readDevicetreeHeader(prefix);
      } catch (cause: unknown) {
        if (!(cause instanceof BinaryFormatFailure)) throw cause;
        return {
          state: "refused",
          format: "devicetree",
          reason: cause.message,
        };
      }
      return { state: "recognized", format: "devicetree" };
    },
    // Binary plists, including keyed archives, often use other extensions.
    when("labview-rsrc", hasLabviewRsrcHeader),
    when("plist", hasBinaryPlistSignature),
    // A plain image: SEGA at 0x100. The SMD layout was decided before the
    // ESP image above.
    ({ prefix, fileSize }) =>
      megaDriveLayout(prefix, fileSize) === "plain"
        ? { state: "recognized", format: "mega-drive-rom" }
        : undefined,
    // No magic: the stored logo CRC and a matching checksum claim it, after
    // every format with a leading signature.
    when("nds", hasNdsHeader),
    // A legacy MBN header has no magic; the version word, sizes and pointer
    // arithmetic must agree, so it runs after every signature format and yields
    // to native executable headers (ELF, PE/DOS MZ, Mach-O, FAT). An ELF MBN is
    // ELF here; root inventory reads it as MBN for its hash segment.
    ({ prefix, fileSize }) =>
      !claimsExecutableHeader(prefix, fileSize) &&
      hasQualcommMbnHeader(prefix, fileSize)
        ? { state: "recognized", format: "qualcomm-mbn" }
        : undefined,
  ];

/**
 * The first recognizer at or after `from` whose format the bytes claim, or
 * `undefined` when none does.
 */
export const recognizeArtifactFormat = (
  input: ArtifactRecognitionInput,
  from = 0,
): ArtifactFormatRecognition | undefined => {
  for (let index = from; index < ARTIFACT_FORMAT_RECOGNIZERS.length; index++) {
    const recognition = ARTIFACT_FORMAT_RECOGNIZERS[index]!(input);
    if (recognition !== undefined) return { ...recognition, index };
  }
  return undefined;
};

/**
 * Recognize content from a bounded prefix and optional suffix without extra
 * reads. A refused claim falls through: a header-only iNES region, for
 * example, has the signature but not the declared cartridge extent. A claim
 * that needs more bytes falls through too: a bounded prefix and trailer
 * cannot locate an ESP flash partition table. The caller's bounded XML
 * signature probe decides plist last.
 */
export const recognizeBoundedArtifactFormat = (
  input: Omit<ArtifactRecognitionInput, "espFlashLayout"> & {
    readonly xmlPlistSignature: boolean;
  },
): Exclude<RecognizedArtifactFormat, "esp-flash-image"> | undefined => {
  for (
    let recognition = recognizeArtifactFormat(input);
    recognition !== undefined;
    recognition = recognizeArtifactFormat(input, recognition.index + 1)
  ) {
    if (
      recognition.state === "recognized" &&
      recognition.format !== "esp-flash-image"
    )
      return recognition.format;
  }
  return input.xmlPlistSignature ? "plist" : undefined;
};

/**
 * Whether a bounded prefix alone lets the table recognize a format. Claims
 * that need more input or refuse do not count. The whole-file firmware probe
 * asks this first, so inventory classification and binary target resolution
 * both rank the table above it: an ISO 9660 image keeps its tree even when a
 * sector-aligned file inside it is a complete UEFI firmware volume.
 */
export const recognizesArtifactPrefix = (
  prefix: Buffer,
  fileSize: number,
): boolean => {
  const input = { prefix, fileSize };
  for (
    let recognition = recognizeArtifactFormat(input);
    recognition !== undefined;
    recognition = recognizeArtifactFormat(input, recognition.index + 1)
  )
    if (recognition.state === "recognized") return true;
  return false;
};
