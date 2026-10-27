import { z } from "zod";

import {
  BINARY_ARCHITECTURES,
  RAW_ONLY_ARCHITECTURES,
} from "./binaryTargetTypes.js";

export const evidenceSubjectFormatSchema = z.enum([
  "hopper",
  "analysis-database",
  "mach-o",
  "elf",
  "pe",
  "dos-mz",
  "dos-com",
  "raw-binary",
  "gamecube-dol",
  "zip",
  "ipa",
  "apk",
  "msix",
  "appx",
  "hap",
  "hsp",
  "app-pack",
  "asar",
  "godot-pck",
  "dmg",
  "pkg",
  "plist",
  "javascript",
  "source-map",
  "directory",
  "file",
  "unknown",
  "mach-o-universal",
  "javascript-bundle",
  "entitlements",
  "pyinstaller",
  "node-sea",
]);

/** Format-owned architecture declarations shared by Evidence and persisted executions. */
export const evidenceSubjectDeclarationShapes = [
  {
    format: evidenceSubjectFormatSchema.exclude(["raw-binary", "gamecube-dol"]),
    architecture: z
      .enum(BINARY_ARCHITECTURES)
      .exclude([...RAW_ONLY_ARCHITECTURES])
      .nullable(),
  },
  {
    format: z.literal("raw-binary"),
    architecture: z.enum(BINARY_ARCHITECTURES).nullable(),
  },
  {
    format: z.literal("gamecube-dol"),
    architecture: z.literal("powerpc"),
  },
] as const;
