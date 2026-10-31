import { constants as fsConstants } from "node:fs";
import { readlink, realpath, stat } from "node:fs/promises";

/** Classification of an inferior's standard input after its debugger detaches. */
export type InferiorInputSink = "durable" | "not-inherited";

interface SelectedTerminal {
  readonly path: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

const NULL_DEVICE = "/dev/null";

/**
 * Read Linux `/proc` descriptor 0 for an identified inferior.
 *
 * Standard input is durable when it is the caller-selected terminal and
 * independent of the debugger when it is a regular file or the null device.
 * Any other target, including a pipe that may be the debugger's own stdin, is
 * unproven.
 */
export const verifyInferiorInputSink = async (
  pid: string,
  terminal: SelectedTerminal,
  verifyOwnedIdentity?: () => Promise<void>,
): Promise<InferiorInputSink> => {
  if (process.platform !== "linux")
    throw new Error(
      "Inferior input descriptors can only be verified through Linux /proc.",
    );
  await verifyOwnedIdentity?.();
  const descriptorPath = `/proc/${pid}/fd/0`;
  let destination: string;
  try {
    destination = await readlink(descriptorPath);
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT" &&
      verifyOwnedIdentity !== undefined
    ) {
      // A process may close fd 0 while retaining its output streams. Confirm
      // the process identity between two observations so a reused PID or a
      // descriptor reopened during the read cannot be mistaken for absence.
      await verifyOwnedIdentity();
      try {
        destination = await readlink(descriptorPath);
      } catch (secondCause) {
        if (
          secondCause instanceof Error &&
          "code" in secondCause &&
          secondCause.code === "ENOENT"
        ) {
          await verifyOwnedIdentity();
          return "not-inherited";
        }
        throw secondCause;
      }
    } else {
      throw cause;
    }
  }
  const observed = await stat(descriptorPath);
  const isCharacterDevice =
    (observed.mode & fsConstants.S_IFMT) === fsConstants.S_IFCHR;
  let classification: InferiorInputSink;
  if (
    isCharacterDevice &&
    observed.dev === terminal.dev &&
    observed.ino === terminal.ino &&
    (await realpath(destination)) === terminal.path
  ) {
    classification = "durable";
  } else if (isCharacterDevice && destination === NULL_DEVICE) {
    // readlink and stat observe the descriptor at different instants. Bind
    // the `/dev/null` name to the stat snapshot by checking the character
    // device number, so a reopened fd cannot pair a stale link with another
    // character device.
    const nullDevice = await stat(NULL_DEVICE);
    if (
      (nullDevice.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR ||
      observed.rdev !== nullDevice.rdev
    )
      throw new Error(
        "Inferior standard input changed while verifying the null device; its independence from the debugger is unverified.",
      );
    classification = "not-inherited";
  } else if ((observed.mode & fsConstants.S_IFMT) === fsConstants.S_IFREG) {
    classification = "not-inherited";
  } else {
    throw new Error(
      "Inferior standard input is neither the selected terminal, the null device, nor an open regular file; its independence from the debugger is unverified.",
    );
  }
  await verifyOwnedIdentity?.();
  return classification;
};
