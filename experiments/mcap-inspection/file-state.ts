import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import { sameRegularFileState } from "../../src/filesystem/RegularFile.js";
import { diagnostic } from "./limits.ts";

export function fileState(metadata: BigIntStats) {
  return {
    size_bytes: String(metadata.size),
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode_bits: String(metadata.mode),
    modified_ns: String(metadata.mtimeNs),
    changed_ns: String(metadata.ctimeNs),
    file_type: metadata.isFile()
      ? "regular"
      : metadata.isSymbolicLink()
        ? "symlink"
        : "other",
  };
}

type NotAttempted = { readonly status: "not_attempted" };
type Failed = {
  readonly status: "failed";
  readonly error: ReturnType<typeof diagnostic>;
};
type MetadataObservation =
  | NotAttempted
  | Failed
  | {
      readonly status: "observed";
      readonly state: ReturnType<typeof fileState>;
    };

export class AdmissionEvidence {
  readonly observations: {
    path: MetadataObservation;
    open: NotAttempted | Failed | { readonly status: "opened" };
    descriptor: MetadataObservation;
    matches_path: boolean | null;
  } = {
    path: { status: "not_attempted" },
    open: { status: "not_attempted" },
    descriptor: { status: "not_attempted" },
    matches_path: null,
  };

  readPath(path: string): BigIntStats {
    return this.#observe("path", () => lstatSync(path, { bigint: true }));
  }

  open(path: string): number {
    try {
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      this.observations.open = { status: "opened" };
      return fd;
    } catch (cause) {
      this.observations.open = {
        status: "failed",
        error: diagnostic(cause, "io_or_usage"),
      };
      throw cause;
    }
  }

  readDescriptor(fd: number, named: BigIntStats): BigIntStats {
    const observed = this.#observe("descriptor", () =>
      fstatSync(fd, { bigint: true }),
    );
    this.observations.matches_path = sameRegularFileState(named, observed);
    return observed;
  }

  #observe(key: "path" | "descriptor", read: () => BigIntStats): BigIntStats {
    try {
      const observed = read();
      this.observations[key] = {
        status: "observed",
        state: fileState(observed),
      };
      return observed;
    } catch (cause) {
      this.observations[key] = {
        status: "failed",
        error: diagnostic(cause, "io_or_usage"),
      };
      throw cause;
    }
  }
}

function observe(initial: BigIntStats, read: () => BigIntStats) {
  try {
    const observed = read();
    return {
      state: fileState(observed),
      matches_initial: sameRegularFileState(initial, observed),
      error: null,
    };
  } catch (cause) {
    return {
      state: null,
      matches_initial: null,
      error: diagnostic(cause, "io"),
    };
  }
}

export function observeFileState(
  fd: number,
  path: string,
  initial: BigIntStats,
) {
  return {
    descriptor: observe(initial, () => fstatSync(fd, { bigint: true })),
    path: observe(initial, () => lstatSync(path, { bigint: true })),
  };
}
