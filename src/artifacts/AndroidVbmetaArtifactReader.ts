import type { ParseFailureError } from "../domain/parseFailure.js";
import {
  DEFAULT_ANDROID_VBMETA_READER_LIMITS,
  type AndroidVbmetaReaderLimits,
} from "../domain/artifactReaderLimits.js";
import {
  ANDROID_VBMETA_LIMIT_SETTINGS,
  AVB_HEADER_SIZE,
  androidVbmetaImageExtent,
  parseAndroidVbmeta,
  type AndroidVbmetaChild,
} from "../domain/firmware/androidVbmeta.js";
import type {
  AndroidVbmetaDescriptorEntryMetadata,
  AndroidVbmetaEntryMetadata,
  AndroidVbmetaMetadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import {
  artifactParseFailure,
  artifactReaderLimitFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

type VbmetaEntry = PositionalArtifactEntry & {
  readonly formatMetadata:
    | AndroidVbmetaEntryMetadata
    | AndroidVbmetaDescriptorEntryMetadata;
};

/** Read a standalone vbmeta image without verifying or modifying it. */
export class AndroidVbmetaArtifactReader extends PositionalArtifactReader<AndroidVbmetaMetadata> {
  override readonly format = "android-vbmeta" as const;
  readonly #limits: AndroidVbmetaReaderLimits;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    limits: AndroidVbmetaReaderLimits = DEFAULT_ANDROID_VBMETA_READER_LIMITS,
  ) {
    super(path, "Android vbmeta", admitted);
    this.#limits = limits;
  }

  formatMetadata(): AndroidVbmetaMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<AndroidVbmetaMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const headerBytes = await readArtifactFileBytes(
      this.format,
      handle,
      0,
      Math.min(initial.size, AVB_HEADER_SIZE),
      initial.size,
      signal,
    );
    this.assertOpen(signal);
    const extent = androidVbmetaImageExtent(
      headerBytes,
      initial.size,
      this.#limits,
    );
    if (!extent.ok) throw parseFailure(extent.error);
    const imageBytes = await readArtifactFileBytes(
      this.format,
      handle,
      0,
      extent.value.imageSize,
      initial.size,
      signal,
    );
    this.assertOpen(signal);
    const parsed = parseAndroidVbmeta(imageBytes, initial.size, this.#limits);
    if (!parsed.ok) throw parseFailure(parsed.error);
    return {
      entries: parsed.value.children.map(entryFor),
      formatMetadata: {
        kind: "android-vbmeta",
        ...parsed.value.metadata,
      },
      coverage: {
        status:
          parsed.value.layoutSupported &&
          parsed.value.metadata.descriptor_failure === null
            ? "complete"
            : "unknown",
        limitations: [...parsed.value.limitations],
      },
    };
  }
}

const parseFailure = (failure: ParseFailureError): unknown => {
  const facts = failure.failure;
  if (facts.kind === "limit") {
    const selected = ANDROID_VBMETA_LIMIT_SETTINGS.get(facts.limit.name);
    if (selected !== undefined)
      return artifactReaderLimitFailure(
        `artifact_limits.android_vbmeta.${selected.setting}`,
        facts.limit.maximum,
        selected.unit,
        facts.limit.required,
        "capacity",
      );
  }
  return artifactParseFailure(failure, undefined, () => "capacity");
};

const entryFor = (child: AndroidVbmetaChild): VbmetaEntry => ({
  path: child.path,
  kind: "file",
  declaredSize: child.size,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: child.offset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [],
  adapterKey: `android-vbmeta:${child.path}`,
  formatMetadata:
    child.role === "descriptor"
      ? {
          kind: "android-vbmeta-descriptor",
          index: child.index,
          tag: String(child.descriptor.tag),
          tag_name: child.descriptor.tag_name,
          descriptor_size: child.size,
        }
      : { kind: "android-vbmeta-entry", role: child.role },
  sourcePath: child.path,
});
