import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FULL_CATALOG_IDENTITY } from "../dist/catalogIdentity.js";

import { parseTarListing } from "./lib/verify-package-listing.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

const { parseSkillManifestMetadata } = await importVerifierSource(
  new URL("../src/domain/skillManifest.ts", import.meta.url).href,
  import.meta.url,
);

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace, commands }) {
  const packDirectory = join(workspace, "pack");
  await mkdir(packDirectory);
  const tarball = join(
    packDirectory,
    (
      await commands.execNpm(
        ["pack", "--silent", "--pack-destination", packDirectory],
        {
          cwd: root,
        },
      )
    ).stdout.trim(),
  );
  const packedFiles = parseTarListing(
    (await commands.exec("tar", ["-tf", tarball])).stdout,
  );
  const packedManifest = JSON.parse(
    (await commands.exec("tar", ["-xOf", tarball, "package/package.json"]))
      .stdout,
  );
  if (
    packedManifest.scripts?.postinstall !== undefined ||
    packedManifest.dependencies?.["node-pty"] !== undefined ||
    packedManifest.dependencies?.["@lydell/node-pty"] !== "1.1.0"
  )
    throw new Error("package retained a lifecycle-dependent PTY installation");
  if (
    packedManifest.bin?.rea !== "scripts/rea.mjs" ||
    packedManifest.bin?.["rea-agents"] !== "scripts/rea.mjs"
  )
    throw new Error("package did not expose both rea command entry points");
  if (packedManifest.mcpName !== "io.github.morluto/rea")
    throw new Error("package did not retain its MCP Registry ownership marker");
  if (!packedFiles.includes("package/scripts/lib/cli-process-environment.mjs"))
    throw new Error("package omitted the CLI process environment owner");
  if (packedFiles.some((path) => path.startsWith("package/.agents/")))
    throw new Error(
      "package included authored skill sources instead of only the generated bundle",
    );
  if (packedFiles.some((path) => path.startsWith("package/.cache/")))
    throw new Error("package included development cache or test metadata");
  const skill = (
    await commands.exec("tar", [
      "-xOf",
      tarball,
      "package/skills/reverse-engineer-anything/SKILL.md",
    ])
  ).stdout;
  const skillMetadata = parseSkillManifestMetadata(skill);
  if (
    !skillMetadata.ok ||
    skillMetadata.value.toolCount !== FULL_CATALOG_IDENTITY.counts.mcp_tools ||
    skillMetadata.value.hasCatalogDigest
  )
    throw new Error(
      "packaged skill metadata did not match the catalog shipped in the package",
    );
  if (
    packedFiles.some(
      (path) => path.includes("__pycache__") || path.endsWith(".pyc"),
    )
  ) {
    throw new Error("package contained generated Python bytecode");
  }
  await verifyPackedBridge({ tarball, packedFiles, commands });
  return { tarball };
}
