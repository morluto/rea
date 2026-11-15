import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OwnedCommandFailure } from "../../src/process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../../src/process/ProviderProcess.js";
import { join } from "node:path";

export const createArtifact = async (): Promise<{
  directory: string;
  path: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-edge-"));
  const path = join(directory, "sample.bin");
  await writeFile(path, "initial artifact");
  return { directory, path };
};

export const providerSnapshot = (
  overrides: Partial<ProviderProcessSnapshot> = {},
): ProviderProcessSnapshot => ({
  stdout: { text: "captured owned output", bytes: 21, observedBytes: 21 },
  stderr: { text: "diagnostic", bytes: 10, observedBytes: 10 },
  exitCode: 0,
  signal: null,
  ...overrides,
});

/** What the owned supervisor returns for a provider process that ended. */
export const ownedOutput = (
  stdout = "",
  stderr = "",
  overrides: Partial<ProviderProcessSnapshot> = {},
): ProviderProcessSnapshot => {
  const stdoutBytes = Buffer.byteLength(stdout);
  const stderrBytes = Buffer.byteLength(stderr);
  return {
    stdout: { text: stdout, bytes: stdoutBytes, observedBytes: stdoutBytes },
    stderr: { text: stderr, bytes: stderrBytes, observedBytes: stderrBytes },
    exitCode: 0,
    signal: null,
    ...overrides,
  };
};

/** What the owned supervisor throws when a command does not finish normally. */
export const ownedFailure = (
  reason: OwnedCommandFailure["reason"],
  snapshot: ProviderProcessSnapshot | null,
  options?: ConstructorParameters<typeof OwnedCommandFailure>[4],
): OwnedCommandFailure =>
  new OwnedCommandFailure(
    reason,
    `owned command ${reason}`,
    snapshot,
    null,
    options,
  );

/**
 * A launcher's refusal to start the command. The owned supervisor rethrows
 * the launcher's spawn error unchanged.
 */
export const ownedLaunchRefusal = (code: string, command = "provider"): Error =>
  Object.assign(new Error(`spawn ${command} ${code}`), {
    code,
    syscall: `spawn ${command}`,
    path: command,
  });

/** Repair guidance for a test-built command profile. */
export const fixtureCommandRepair = {
  provider: "fixture",
  setting: "REA_FIXTURE_COMMAND",
  remediationAction: "Configure the fixture command.",
} as const;
