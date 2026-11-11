#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = new URL("src/domain/windowsNativeArtifact.ts", root);
let sourceExists = true;
try {
  await access(source);
} catch (cause) {
  if (cause?.code !== "ENOENT") throw cause;
  sourceExists = false;
}
const owner = sourceExists
  ? await (
      await import("./lib/verifier-source-loader.mjs")
    ).importVerifierSource(source.href, import.meta.url)
  : await import(new URL("dist/domain/windowsNativeArtifact.js", root).href);
const {
  WINDOWS_NATIVE_SOURCE_FILES,
  WINDOWS_NATIVE_TARGETS,
  computeWindowsNativeSourceSha256,
  parseWindowsNativeManifest,
  validateWindowsNativeArtifact,
} = owner;
const exists = (url) =>
  access(url).then(
    () => true,
    () => false,
  );
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const rawManifest = JSON.parse(
  await readFile(new URL("native/windows/build/manifest.json", root), "utf8"),
);
const parsed = parseWindowsNativeManifest(rawManifest, packageJson.version);
if (!parsed.ok) throw parsed.error;
const manifest = parsed.value;
if (await exists(new URL("native/windows/src/addon.cc", root))) {
  const sourceEntries = await Promise.all(
    WINDOWS_NATIVE_SOURCE_FILES.map(async (path) => [
      path,
      await readFile(new URL(path, root)),
    ]),
  );
  const expectedSource = computeWindowsNativeSourceSha256(
    Object.fromEntries(sourceEntries),
  );
  if (!expectedSource.ok) throw expectedSource.error;
  if (manifest.sourceSha256 !== expectedSource.value)
    throw new Error(
      "Windows native artifact sourceSha256 does not match native/windows/src; rerun the Windows native build lane.",
    );
}
const declaredArchitectures =
  manifest.artifacts === undefined
    ? [manifest.architecture]
    : Object.keys(manifest.artifacts).filter(
        (architecture) => manifest.artifacts[architecture] !== undefined,
      );
let artifactBytes = 0;
for (const architecture of declaredArchitectures) {
  const targetManifest = parseWindowsNativeManifest(
    rawManifest,
    packageJson.version,
    architecture,
  );
  if (!targetManifest.ok) throw targetManifest.error;
  const bytes = await readFile(
    new URL(`native/windows/build/${targetManifest.value.artifact}`, root),
  );
  const valid = validateWindowsNativeArtifact(targetManifest.value, bytes);
  if (!valid.ok) throw valid.error;
  if (architecture === manifest.architecture) artifactBytes = bytes.length;
}
for (const [architecture, target] of Object.entries(WINDOWS_NATIVE_TARGETS)) {
  if (
    !declaredArchitectures.includes(architecture) &&
    (await exists(new URL(`native/windows/build/${target.artifact}`, root)))
  )
    throw new Error(
      `Unindexed Windows native artifact present in native/windows/build/${target.artifact}; rerun the Windows native build lane.`,
    );
}
process.stdout.write(
  `${JSON.stringify({ ok: true, ...manifest, artifactBytes })}\n`,
);
