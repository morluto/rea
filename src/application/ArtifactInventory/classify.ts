import { open } from "node:fs/promises";

import { classifyArtifactContent } from "../ArtifactGraphConstruction.js";
import { ARTIFACT_CLASSIFICATION_PREFIX_BYTES } from "./hash.js";
import type { ArtifactNode } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
} from "../../domain/zipPackageFormat.js";

const classifyContainerExtension = (
  path: string,
): ArtifactNode["format"] | undefined => {
  const lower = path.toLowerCase();
  const zipPackage = zipPackageFormatForPath(lower);
  if (zipPackage !== undefined) return zipPackage;
  for (const format of ["asar", "dmg", "pkg"] as const)
    if (lower.endsWith(`.${format}`)) return format;
  return undefined;
};

export const classifyRoot = async (
  path: string,
  directory: boolean,
): Promise<ArtifactNode["format"]> => {
  if (directory) return "directory";
  const extensionFormat = classifyContainerExtension(path);
  if (extensionFormat !== undefined) return extensionFormat;
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(ARTIFACT_CLASSIFICATION_PREFIX_BYTES);
    const observed = await handle.read(magic, 0, magic.length, 0);
    const prefix = magic.subarray(0, observed.bytesRead);
    if (hasZipSignature(prefix)) return "zip";
    return classifyArtifactContent(path, prefix, (await handle.stat()).size)
      .format;
  } finally {
    await handle.close();
  }
};
