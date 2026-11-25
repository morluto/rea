import { classifyArtifactContent } from "../../src/artifacts/inventory/ArtifactGraphConstruction.js";
import { createXmlPlistSignatureProbe } from "../../src/domain/apple/appleArchiveFormat.js";
import { readFatContainerHeader } from "../../src/domain/apple/machoContainer.js";
import { createAsarHeaderSignatureProbe } from "../../src/resources/index.js";

/** Observe a supplied byte prefix before assigning an inventory path role. */
export const classifyArtifactBytesAtPath = (
  path: string,
  bytes: Buffer,
  fileSize = bytes.length,
) => {
  const probe = createAsarHeaderSignatureProbe();
  probe.write(bytes);
  const { kind, format } = classifyArtifactContent(
    path,
    {
      prefix: bytes,
      xmlPlistSignature:
        createXmlPlistSignatureProbe().write(bytes) === "matched",
      asarHeader: probe.finish(fileSize),
      fatHeader: readFatContainerHeader(bytes, fileSize),
      fatSliceHeadersByOffset: new Map(),
    },
    fileSize,
  );
  return { kind, format };
};
