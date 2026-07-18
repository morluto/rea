import { join } from "node:path";

import { exec } from "./lib/verify-package-core.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace }) {
  const tarball = (
    await exec("npm", ["pack", "--silent"], { cwd: root })
  ).stdout.trim();
  const packedFiles = (
    await exec("tar", ["-tf", join(root, tarball)])
  ).stdout.split("\n");
  const packedManifest = JSON.parse(
    (await exec("tar", ["-xOf", join(root, tarball), "package/package.json"]))
      .stdout,
  );
  if (
    packedManifest.scripts?.postinstall !== undefined ||
    packedManifest.dependencies?.["node-pty"] !== undefined ||
    packedManifest.dependencies?.["@lydell/node-pty"] !== "1.1.0"
  )
    throw new Error("package retained a lifecycle-dependent PTY installation");
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
