import { open } from "node:fs/promises";

import { classifyArtifactPath } from "../ArtifactGraphConstruction.js";
import type { ArtifactNode } from "../../domain/artifactGraph.js";

export const classifyContainerExtension = (
  path: string,
): ArtifactNode["format"] | undefined => {
  const lower = path.toLowerCase();
  for (const format of ["asar", "ipa", "apk", "zip", "dmg", "pkg"] as const)
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
    const magic = Buffer.alloc(4);
    const observed = await handle.read(magic, 0, magic.length, 0);
    if (
      observed.bytesRead === 4 &&
      magic[0] === 0x50 &&
      magic[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(magic[2] ?? -1) &&
      [0x04, 0x06, 0x08].includes(magic[3] ?? -1)
    )
      return "zip";
    if (observed.bytesRead === 4) {
      const header = magic.readUInt32BE(0);
      if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header))
        return "mach-o-universal";
      if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(header))
        return "mach-o";
      if (magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";
    }
    if (observed.bytesRead >= 2 && magic[0] === 0x4d && magic[1] === 0x5a)
      return "pe";
  } finally {
    await handle.close();
  }
  return classifyArtifactPath(path).format;
};
