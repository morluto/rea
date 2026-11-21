import type { ParseFailureError } from "../domain/parseFailure.js";
import {
  ANDROID_VBMETA_FIXED_LIMITS,
  AVB_HEADER_SIZE,
  androidVbmetaImageExtent,
  parseAndroidVbmeta,
  type AndroidVbmetaChild,
} from "../domain/firmware/androidVbmeta.js";
import type {
  AndroidVbmetaEntryMetadata,
  AndroidVbmetaMetadata,
} from "../domain/artifactFormatMetadata.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

type VbmetaEntry = PositionalArtifactEntry & {
  readonly formatMetadata: AndroidVbmetaEntryMetadata;
};

/** Read a standalone vbmeta image without verifying or modifying it. */
export class AndroidVbmetaArtifactReader extends PositionalArtifactReader<AndroidVbmetaMetadata> {
  override readonly format = "android-vbmeta" as const;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "Android vbmeta", admitted);
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
      handle,
      0,
      Math.min(initial.size, AVB_HEADER_SIZE),
      initial.size,
      signal,
    );
    this.assertOpen(signal);
    const extent = androidVbmetaImageExtent(headerBytes, initial.size);
    if (!extent.ok) throw parseFailure(extent.error);
    const imageBytes = await readArtifactFileBytes(
      handle,
      0,
      extent.value.imageSize,
      initial.size,
      signal,
    );
    this.assertOpen(signal);
    const parsed = parseAndroidVbmeta(imageBytes, initial.size);
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
    const ceiling = ANDROID_VBMETA_FIXED_LIMITS.get(facts.limit.name);
    if (ceiling !== undefined)
      return artifactFixedLimitFailure(
        {
          name: ceiling.name,
          kind: "parser",
          limit: facts.limit.maximum,
          unit: ceiling.unit,
        },
        failure.message,
        "capacity",
        { cause: failure },
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
  formatMetadata: {
    kind: "android-vbmeta-entry",
    role: child.role,
  },
  sourcePath: child.path,
});
