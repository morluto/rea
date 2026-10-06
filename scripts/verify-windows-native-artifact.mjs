#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("native/windows/build/manifest.json", root), "utf8"),
);
const bytes = await readFile(
  new URL("native/windows/build/rea-windows-x64.node", root),
);
if (
  manifest.packageVersion !== packageJson.version ||
  manifest.platform !== "win32" ||
  manifest.architecture !== "x64" ||
  manifest.abiVersion !== 1 ||
  manifest.nodeApiVersion !== 8 ||
  manifest.artifact !== "rea-windows-x64.node" ||
  createHash("sha256").update(bytes).digest("hex") !== manifest.artifactSha256
)
  throw new Error(
    "Windows native artifact metadata or SHA-256 does not match this package; run the Windows native build lane.",
  );
const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
if (
  bytes.toString("ascii", 0, 2) !== "MZ" ||
  offset > bytes.length - 26 ||
  bytes.toString("ascii", offset, offset + 4) !== "PE\0\0" ||
  bytes.readUInt16LE(offset + 4) !== 0x8664 ||
  bytes.readUInt16LE(offset + 24) !== 0x20b
)
  throw new Error("Windows native artifact must be a Windows x64 PE32+ image.");
process.stdout.write(
  `${JSON.stringify({ ok: true, ...manifest, artifactBytes: bytes.length })}\n`,
);
