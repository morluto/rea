import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { exec, json, run } from "./lib/verify-package-core.mjs";

/** Install the packed CLI globally with and without optional dependencies and verify PTY degradation. */
export async function verifyPackageInstall({
  root,
  tarball,
  prefix,
  workspace,
  environment,
}) {
  await exec(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--prefix",
      prefix,
      join(root, tarball),
    ],
    { env: environment },
  );
  const cli = join(prefix, "bin", "rea");
  const processCaptureCapabilityUrl = pathToFileURL(
    join(
      prefix,
      "lib/node_modules/rea-agents/dist/application/ProcessCaptureCapability.js",
    ),
  ).href;
  const processCaptureCapability = json(
    (
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { probeProcessCaptureCapability } = await import(${JSON.stringify(processCaptureCapabilityUrl)}); process.stdout.write(JSON.stringify(await probeProcessCaptureCapability()));`,
        ],
        { env: environment },
      )
    ).stdout,
  );
  if (processCaptureCapability.available !== true)
    throw new Error(
      `packaged PTY backend failed without lifecycle scripts: ${JSON.stringify(processCaptureCapability)}`,
    );
  const noOptionalPrefix = join(workspace, "prefix-no-optional");
  await exec(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--omit=optional",
      "--prefix",
      noOptionalPrefix,
      join(root, tarball),
    ],
    { env: environment },
  );
  const noOptionalCli = join(noOptionalPrefix, "bin", "rea");
  await rm(
    join(
      noOptionalPrefix,
      "lib/node_modules/rea-agents/node_modules/@lydell",
      `node-pty-${process.platform}-${process.arch}`,
    ),
    { recursive: true, force: true },
  );
  const noOptionalCapabilityUrl = pathToFileURL(
    join(
      noOptionalPrefix,
      "lib/node_modules/rea-agents/dist/application/ProcessCaptureCapability.js",
    ),
  ).href;
  const noOptionalCapability = json(
    (
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { probeProcessCaptureCapability } = await import(${JSON.stringify(noOptionalCapabilityUrl)}); process.stdout.write(JSON.stringify(await probeProcessCaptureCapability()));`,
        ],
        { env: environment },
      )
    ).stdout,
  );
  if (
    !(await run(noOptionalCli, ["--help"], environment)).includes("setup") ||
    noOptionalCapability.available !== false
  )
    throw new Error(
      `packaged CLI did not degrade without the optional PTY binary: ${JSON.stringify(noOptionalCapability)}`,
    );
  return { cli };
}
