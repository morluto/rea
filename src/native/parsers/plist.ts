import { z } from "zod";

import { AnalysisOutputError } from "../../domain/errors.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseJson } from "../../domain/safeJson.js";

const plistObject = z.record(z.string(), z.unknown());

/** Parse plutil JSON output and project stable bundle metadata. */
export const parsePlistJson = (
  output: string,
): Result<
  {
    readonly value: unknown;
    readonly bundle: {
      readonly identifier: string | null;
      readonly executable: string | null;
      readonly name: string | null;
      readonly version: string | null;
      readonly short_version: string | null;
    };
  },
  AnalysisOutputError
> => {
  // plutil output can carry a UTF-8 BOM, which JSON.parse rejects outright.
  const parsed = safeParseJson(output.replace(/^\uFEFF/u, ""));
  if (!parsed.ok)
    return err(
      new AnalysisOutputError("inspect_plist", parsed.error, {
        cause: parsed.cause,
      }),
    );
  const value: unknown = parsed.value;
  const object = plistObject.safeParse(value);
  const field = (name: string): string | null => {
    if (!object.success) return null;
    const candidate = object.data[name];
    return typeof candidate === "string" ? candidate : null;
  };
  return ok({
    value,
    bundle: {
      identifier: field("CFBundleIdentifier"),
      executable: field("CFBundleExecutable"),
      name: field("CFBundleName"),
      version: field("CFBundleVersion"),
      short_version: field("CFBundleShortVersionString"),
    },
  });
};
