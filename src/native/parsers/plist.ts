import { z } from "zod";

const plistObject = z.record(z.string(), z.unknown());

/** Parse plutil JSON output and project stable bundle metadata. */
export const parsePlistJson = (output: string) => {
  const value: unknown = JSON.parse(output);
  const object = plistObject.safeParse(value);
  const field = (name: string): string | null => {
    if (!object.success) return null;
    const candidate = object.data[name];
    return typeof candidate === "string" ? candidate : null;
  };
  return {
    value,
    bundle: {
      identifier: field("CFBundleIdentifier"),
      executable: field("CFBundleExecutable"),
      name: field("CFBundleName"),
      version: field("CFBundleVersion"),
      short_version: field("CFBundleShortVersionString"),
    },
  };
};
