import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packedHopperBridge = "package/bridge/hopper_bridge.py";
const packedGhidraBridge = "package/bridge/ghidra/ReaGhidraBridge.java";

/** Verify regex search through the packaged production bridge. */
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
  await exec("tar", ["-xf", tarball, "-C", workspace]);
  const ghidraSource = await readFile(
    join(workspace, packedGhidraBridge),
    "utf8",
  );
  for (const commitment of [
    "extends HeadlessScript",
    'request.method.equals("ping")',
    'request.method.equals("shutdown")',
    'boolean readOnly = !descriptor.transport.equals("unix-socket")',
    'result.addProperty("read_only", readOnly)',
    'case "annotate_native_function"',
    'currentProgram.startTransaction("REA function annotations")',
    "currentProgram.endTransaction(transaction, commit)",
    "analysisTimeoutOccurred()",
  ])
    if (!ghidraSource.includes(commitment))
      throw new Error(`packaged Ghidra bridge omitted ${commitment}`);
  const probe = JSON.parse(
    (
      await exec("python3", [
        join(root, "tests/fixtures/bridgeSearchProbe.py"),
        join(workspace, packedHopperBridge),
        JSON.stringify({
          action: "search",
          items: [
            ["0x1000", "REA_GHIDRA_INVENTORY_ENTRY"],
            ["0x2000", "unrelated"],
            ["0x3000", "REA_GHIDRA_LEAF_VALUE"],
          ],
          params: {
            pattern: "^REA_GHIDRA_(?:INVENTORY_ENTRY|LEAF_VALUE)$",
            mode: "regex",
            case_sensitive: true,
          },
        }),
      ])
    ).stdout,
  );
  const matches = probe.result;
  if (
    probe.ok !== true ||
    !Array.isArray(matches) ||
    matches.length !== 2 ||
    matches[0]?.address !== "0x1000" ||
    matches[0]?.value !== "REA_GHIDRA_INVENTORY_ENTRY" ||
    matches[1]?.address !== "0x3000" ||
    matches[1]?.value !== "REA_GHIDRA_LEAF_VALUE"
  )
    throw new Error(
      `packaged Hopper bridge regex search drifted: ${JSON.stringify(probe)}`,
    );
}
