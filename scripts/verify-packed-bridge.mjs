import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packedBridge = "package/bridge/hopper_bridge.py";

/** Verify that the packed production bridge rejects a catastrophic regex. */
export async function verifyPackedBridge({
  root,
  workspace,
  tarball,
  packedFiles,
}) {
  if (!packedFiles.includes(packedBridge))
    throw new Error("package omitted the Hopper bridge");
  await exec("tar", ["-xf", join(root, tarball), "-C", workspace]);
  const probe = JSON.parse(
    (
      await exec("python3", [
        join(root, "tests/fixtures/bridgeRegexProbe.py"),
        join(workspace, packedBridge),
        JSON.stringify({
          action: "match",
          pattern: "(a|aa){1,35}b",
          value: "a".repeat(35),
          case_sensitive: true,
        }),
      ])
    ).stdout,
  );
  if (
    probe.ok !== false ||
    probe.diagnostic_type !== "invalid_request" ||
    probe.message !== "Regex exceeds the 10000-path backtracking budget"
  )
    throw new Error(
      `packaged Hopper bridge omitted regex bounds: ${JSON.stringify(probe)}`,
    );
}
