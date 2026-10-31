import type { FileState } from "./processCapture.js";

/** Preserve stored bytes; undecodable targets have no invented text spelling. */
export const observedSymlinkTarget = (
  raw: Buffer,
): { text: string | null; hex: string } => {
  const decoded = raw.toString("utf8");
  return {
    text: Buffer.from(decoded, "utf8").equals(raw) ? decoded : null,
    hex: raw.toString("hex"),
  };
};

/** Old replacement characters cannot establish the target's original bytes. */
export const symlinkTargetIdentity = (
  file: Extract<FileState, { type: "symlink" }>,
): string | null => {
  if (file.symlink_target_hex !== undefined) return file.symlink_target_hex;
  const text = file.symlink_target;
  if (text === null || text.includes("\ufffd")) return null;
  const raw = Buffer.from(text, "utf8");
  return raw.toString("utf8") === text ? raw.toString("hex") : null;
};
