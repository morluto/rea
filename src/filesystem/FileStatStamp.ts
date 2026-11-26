import type { BigIntStats } from "node:fs";

/** Metadata used by callers that compare device, inode, size and nanosecond times. */
export type FileStatStamp = Readonly<
  Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">
>;

export const fileStatStamp = (stats: FileStatStamp): FileStatStamp => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
});

export const sameFileStatStamp = (
  left: FileStatStamp,
  right: FileStatStamp,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
