import { Writable } from "node:stream";

import type { CliServeOptions } from "./types.js";

/**
 * Where one invocation writes its result document. A callback owns captured
 * output and keeps the process terminal's presentation; otherwise the process
 * owns stdout directly.
 */
export const cliResultDestination = (
  stdout: CliServeOptions["stdout"],
): Writable => {
  if (stdout === undefined) return process.stdout;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        stdout(chunk.toString("utf8"));
        done();
      } catch (cause) {
        done(cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
  });
  Object.defineProperty(destination, "isTTY", {
    value: process.stdout.isTTY === true,
  });
  return destination;
};
