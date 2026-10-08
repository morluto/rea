import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";

import { exec } from "./lib/verify-package-core.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace }) {
  const packDirectory = join(workspace, "pack");
  await mkdir(packDirectory);
  const tarball = join(
    packDirectory,
    (
      await exec(
        "npm",
        ["pack", "--silent", "--pack-destination", packDirectory],
        {
          cwd: root,
        },
      )
    ).stdout.trim(),
  );
  const packedFiles = (await exec("tar", ["-tf", tarball])).stdout.split("\n");
  const packedManifest = JSON.parse(
    (await exec("tar", ["-xOf", tarball, "package/package.json"])).stdout,
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
  if (packedFiles.some((path) => path.startsWith("package/skill-src/")))
    throw new Error(
      "package included authored skill sources instead of only the generated bundle",
    );
  if (
    packedFiles.some((path) =>
      /^package\/(?:dist|src)\/generatedMcpToolCatalog\./u.test(path),
    )
  )
    throw new Error("package included the test-only generated MCP catalog");
  const skill = (
    await exec("tar", [
      "-xOf",
      tarball,
      "package/skills/reverse-engineer-anything/SKILL.md",
    ])
  ).stdout;
  if (
    !skill.includes(
      `  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}\n`,
    ) ||
    skill.includes("  catalog_digest:")
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
  await verifyPackedBridge({ root, workspace, tarball, packedFiles });
  return { tarball };
}
