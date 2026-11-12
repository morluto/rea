import { z } from "zod";

import { normalizeHttpHostname } from "./httpHostname.js";
import { err, ok, type Result } from "./result.js";

/** Agentenv folder and local-id spelling, also used for authored task files. */
export const PORTABLE_BUNDLE_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/u;
// A compose service name is one DNS label, whose wire limit is 63 octets.
export const PORTABLE_BUNDLE_NAME_MAX_LENGTH = 63;
export const PORTABLE_BUNDLE_NAME_CONSTRAINT = `a kebab-case label of at most ${String(PORTABLE_BUNDLE_NAME_MAX_LENGTH)} characters, excluding Windows device names, that remains unchanged as an HTTP service hostname`;
const WINDOWS_RESERVED_PART = "con|prn|aux|nul|com[1-9]|lpt[1-9]";
const WINDOWS_RESERVED_NAME = new RegExp(`^(?:${WINDOWS_RESERVED_PART})$`, "u");
// A single label ending in a number is parsed as an IPv4 address by URL.
// With this module's ASCII label grammar those are decimal and hexadecimal forms.
const NON_NUMERIC_HOSTNAME_PATTERN = /^(?!(?:[0-9]+|0x[0-9a-f]*)$)/u;
const NON_RESERVED_NAME_PATTERN =
  /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)/u;

export type PortableBundleNameFailure = "format" | "reserved" | "hostname";

/** Admit the exact source name without normalizing it into another identity. */
export const parsePortableBundleName = (
  name: string,
): Result<string, PortableBundleNameFailure> => {
  if (
    !PORTABLE_BUNDLE_NAME_PATTERN.test(name) ||
    name.length > PORTABLE_BUNDLE_NAME_MAX_LENGTH
  )
    return err("format");
  if (WINDOWS_RESERVED_NAME.test(name)) return err("reserved");
  if (normalizeHttpHostname(name) !== name) return err("hostname");
  return ok(name);
};

/** Boolean admission for callers that do not project a refusal. */
export const isPortableBundleName = (name: string): boolean =>
  parsePortableBundleName(name).ok;

/** Lookup names share portable identity; authoring reservations are separate. */
export const portableBundleNameSchema = z
  .string()
  .regex(PORTABLE_BUNDLE_NAME_PATTERN)
  .max(PORTABLE_BUNDLE_NAME_MAX_LENGTH)
  .regex(NON_NUMERIC_HOSTNAME_PATTERN)
  .regex(NON_RESERVED_NAME_PATTERN)
  .refine(isPortableBundleName, `Expected ${PORTABLE_BUNDLE_NAME_CONSTRAINT}`);
