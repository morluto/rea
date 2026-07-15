import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packedHopperBridge = "package/bridge/hopper_bridge.py";
const packedGhidraBridge = "package/bridge/ghidra/ReaGhidraBridge.java";

/** Verify that the packed production bridge rejects a catastrophic regex. */
export async function verifyPackedBridge({
  root,
  workspace,
  tarball,
  packedFiles,
}) {
  if (!packedFiles.includes(packedHopperBridge))
    throw new Error("package omitted the Hopper bridge");
  if (!packedFiles.includes(packedGhidraBridge))
    throw new Error("package omitted the Ghidra bridge");
  await exec("tar", ["-xf", join(root, tarball), "-C", workspace]);
  const ghidraSource = await readFile(
    join(workspace, packedGhidraBridge),
    "utf8",
  );
  for (const commitment of [
    "extends HeadlessScript",
    'request.method.equals("ping")',
    'request.method.equals("shutdown")',
    'result.addProperty("read_only", true)',
    "analysisTimeoutOccurred()",
  ])
    if (!ghidraSource.includes(commitment))
      throw new Error(`packaged Ghidra bridge omitted ${commitment}`);
  const probe = JSON.parse(
    (
      await exec("python3", [
        join(root, "tests/fixtures/bridgeRegexProbe.py"),
        join(workspace, packedHopperBridge),
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
