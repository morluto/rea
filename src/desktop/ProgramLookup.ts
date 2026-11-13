import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";

import { err, ok, type Result } from "../domain/result.js";

/** An absent candidate is different from one that could not be inspected or executed. */
export type ProgramLookupFailure =
  | { readonly reason: "not_found" }
  | { readonly reason: "not_file"; readonly path: string }
  | {
      readonly reason: "unavailable";
      readonly path: string;
      readonly cause: unknown;
    };

const executable = async (
  path: string,
): Promise<Result<void, ProgramLookupFailure>> => {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile()
      ? ok(undefined)
      : err({ reason: "not_file", path });
  } catch (cause: unknown) {
    return err(
      cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR")
        ? { reason: "not_found" }
        : { reason: "unavailable", path, cause },
    );
  }
};

/** A path without empty or `.` segments, which name nothing; `..` stays, since it climbs from a link's target. */
const tidy = (path: string): string =>
  path.replace(/\/(?:\.?\/)+/gu, "/").replace(/(?<=.)\/\.?$/u, "");

/** A program as found, and whether a relative or empty PATH entry found it. */
export interface FoundProgram {
  readonly path: string;
  readonly fromRelativeEntry: boolean;
}

/**
 * Find a program as the launch will, without running a shell: a relative path,
 * or an empty or relative PATH entry, is read from the directory the program
 * is started in, in PATH order. `..` is kept, so after a symbolic link it
 * means what it means to the launch. A later executable wins over an earlier
 * refused candidate; retain the first refusal if no executable is found.
 */
export const resolveProgram = async (
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
): Promise<Result<FoundProgram, ProgramLookupFailure>> => {
  const from = (path: string) =>
    tidy(isAbsolute(path) ? path : `${startedIn}/${path}`);
  if (program.includes("/")) {
    const path = from(program);
    const candidate = await executable(path);
    return candidate.ok ? ok({ path, fromRelativeEntry: false }) : candidate;
  }
  let refusal: ProgramLookupFailure | undefined;
  for (const directory of environment.PATH?.split(delimiter) ?? []) {
    const path = from(directory === "" ? program : `${directory}/${program}`);
    const candidate = await executable(path);
    if (candidate.ok)
      return ok({ path, fromRelativeEntry: !isAbsolute(directory) });
    if (candidate.error.reason !== "not_found") refusal ??= candidate.error;
  }
  return err(refusal ?? { reason: "not_found" });
};
