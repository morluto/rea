import type { ArtifactFormatId } from "./artifactGraph.js";
import { hasAndroidBootImageMagic } from "./androidBootImageFormat.js";
import { hasBinaryPlistSignature } from "./apple/appleArchiveFormat.js";
import { hasDfuSePrefix, isDfuSeFile } from "./firmware/dfuse.js";
import { ESP8266_REFUSAL, recognizeEspImage } from "./firmware/espImage.js";
import { hasFitImagesNode } from "./firmware/fitImage.js";
import { detectHexRecordEncoding } from "./firmware/hexRecords.js";
import { hasUf2Block } from "./firmware/uf2.js";
import { hasGodotPckHeader } from "./godotPckFormat.js";
import { nesContainerFormat, parseInesLayout } from "./inesContainer.js";
import { recognizeAndroidOtaPayload } from "./firmware/androidOtaPayload.js";
import { hasUImageMagic } from "./uimageFormat.js";
import { hasUnityFsHeader } from "./unityfsFormat.js";
import { hasCompoundFileSignature } from "./windows/compoundFile.js";
import { hasMftFileRecordHeader } from "./windows/ntfsMft.js";
import { hasWxapkgEncryptedMagic, hasWxapkgHeader } from "./wxapkgFormat.js";
import { hasZipSignature } from "./zipPackageFormat.js";

/** Formats recognized from leading bytes before native executable headers. */
export type RecognizedArtifactFormat = Extract<
  ArtifactFormatId,
  | "ines"
  | "zip"
  | "godot-pck"
  | "unityfs"
  | "wxapkg"
  | "uimage"
  | "android-boot-image"
  | "android-ota-payload"
  | "intel-hex"
  | "srec"
  | "uf2"
  | "dfuse"
  | "esp-flash-image"
  | "esp-image"
  | "fit"
  | "compound-file"
  | "ntfs-mft"
  | "plist"
>;

/** The bytes one route has read when it asks which format a file holds. */
export interface ArtifactRecognitionInput {
  /** Leading bytes; routes read different prefix lengths. */
  readonly prefix: Buffer;
  readonly fileSize: number;
  /** The final DFU suffix bytes, when the route has read them. */
  readonly suffix?: Uint8Array | undefined;
  /** Whether an ESP flash partition layout was located, when the route looked. */
  readonly espFlashLayout?: boolean | undefined;
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
 * The one ordered recognizer table. Inventory classification and binary
 * target resolution both walk it, so the same bytes reach the same verdict;
 * each route decides only what a refusal or a missing input means for it.
 */
export const ARTIFACT_FORMAT_RECOGNIZERS: readonly ArtifactFormatRecognizer[] =
  [
    ({ prefix, fileSize }) => {
      if (nesContainerFormat(prefix) === undefined) return undefined;
      const layout = parseInesLayout(prefix, fileSize);
      return layout.ok
        ? { state: "recognized", format: "ines" }
        : { state: "refused", format: "ines", reason: layout.error.detail };
    },
    when("zip", hasZipSignature),
    when("godot-pck", hasGodotPckHeader),
    when("unityfs", hasUnityFsHeader),
    when(
      "wxapkg",
      (prefix) => hasWxapkgEncryptedMagic(prefix) || hasWxapkgHeader(prefix),
    ),
    when("uimage", hasUImageMagic),
    when("android-boot-image", hasAndroidBootImageMagic),
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
    ({ prefix }) => {
      const format = detectHexRecordEncoding(prefix);
      return format === undefined ? undefined : { state: "recognized", format };
    },
    when("uf2", hasUf2Block),
    ({ prefix, suffix, fileSize }) => {
      if (!hasDfuSePrefix(prefix)) return undefined;
      if (suffix === undefined)
        return { state: "needs-input", format: "dfuse" };
      return isDfuSeFile(prefix, suffix, fileSize)
        ? { state: "recognized", format: "dfuse" }
        : undefined;
    },
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
    when("compound-file", hasCompoundFileSignature),
    when("ntfs-mft", hasMftFileRecordHeader),
    // Binary plists, including keyed archives, often use other extensions.
    when("plist", hasBinaryPlistSignature),
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
