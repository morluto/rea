import { createHash } from "node:crypto";

import { z } from "zod";

import { err, ok, type Result } from "../result.js";
import type { DesktopCheckpoint } from "./desktopCapture.js";
import { isWithinAny } from "./desktopStateDiff.js";

/** The checkpoints a build marks around a sign-in or a licence's activation; what changes between them is withheld. */
export const SIGN_IN_START = "pre-sign-in";
export const SIGN_IN_END = "post-sign-in";
/** The largest withheld file a deploy can take back as a setting: its base64 must fit one environment variable. */
export const MAX_WITHHELD_BYTES = 48 * 1024;

/** Which files to withhold: those changed after `from` up to `to`, and the home paths `paths` names. */
export interface WithholdSelection {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly paths?: readonly string[] | undefined;
}

/** A withheld file and how a deploy takes it back: the app's secret setting, the environment variable that holds its bytes in base64, and the handle of the secret file REA keeps it in. */
export interface WithheldFile {
  readonly file: string;
  readonly setting: string;
  readonly variable: string;
  readonly handle: string;
}

/** A consent the person gave, in their own words, as `consent.json` keeps it. */
export const buildConsentSchema = z.strictObject({
  kind: z.enum(["licence", "seed_sign_in"]),
  subject: z.string().min(1),
  url: z.string().optional(),
  words: z.string().min(1),
  recorded_at: z.string().min(1),
  source: z.literal("relayed"),
});
export type BuildConsent = z.output<typeof buildConsentSchema>;
export const consentFileSchema = z.strictObject({
  consents: z.array(buildConsentSchema),
});

/** A home path without a leading `~/`. */
const homeRelative = (path: string): string =>
  path.startsWith("~/") ? path.slice(2) : path;

/** The owned files that changed in the window's checkpoints and those the selection names, sorted; refused for a window it cannot place or a path outside the owned ones. */
export const withheldFiles = (
  checkpoints: readonly DesktopCheckpoint[],
  homePath: (path: string) => string | null,
  owned: readonly string[],
  { from, to, paths = [] }: WithholdSelection,
): Result<string[], string> => {
  const outside = paths
    .map(homeRelative)
    .filter((path) => !isWithinAny(path, owned));
  if (outside.length > 0)
    return err(
      `${outside.join(", ")} lies under none of the paths the bundle owns (${owned.join(", ") || "none"}), so it is not seeded and needs no withholding`,
    );
  const named = paths.map(homeRelative);
  if (from === undefined && to === undefined)
    return ok([...new Set(named)].sort());
  if (from === undefined || to === undefined)
    return err(
      `A sign-in window needs both ${SIGN_IN_START} and ${SIGN_IN_END}; mark the one missing, around the sign-in`,
    );
  const position = (name: string) =>
    checkpoints.findIndex((checkpoint) => checkpoint.name === name);
  const start = position(from);
  const end = position(to);
  if (start === -1 || end === -1)
    return err(
      `The capture has no checkpoint ${start === -1 ? from : to}; its checkpoints are ${checkpoints.map(({ name }) => name).join(", ")}`,
    );
  if (end <= start)
    return err(`${to} was marked before ${from}; mark ${from} first`);
  const changed = checkpoints
    .slice(start + 1, end + 1)
    .flatMap(({ changes }) => changes)
    .filter(
      ({ kind, after }) => kind !== "deleted" && after?.type !== "directory",
    )
    .map(({ path }) => homePath(path))
    .filter(
      (home): home is string => home !== null && isWithinAny(home, owned),
    );
  return ok([...new Set([...changed, ...named])].sort());
};

const upper = (text: string): string =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

/** The most characters a variable takes, so its handle stays within one. */
const MAX_VARIABLE = 60;

/** Each withheld file's setting, environment variable and handle, distinct within the app. */
export const withheldSettings = (
  app: string,
  files: readonly string[],
): WithheldFile[] => {
  const prefix = `REA_${upper(app).slice(0, 20)}_`;
  const taken = new Set<string>();
  return files.map((file) => {
    const hash = createHash("sha256")
      .update(file)
      .digest("hex")
      .slice(0, 8)
      .toUpperCase();
    const plain = `${prefix}${upper(file) || "FILE"}`;
    const variable =
      plain.length <= MAX_VARIABLE && !taken.has(plain)
        ? plain
        : `${prefix}${upper(file).slice(-(MAX_VARIABLE - prefix.length - 9))}_${hash}`.replace(
            /_+(?=_)/gu,
            "",
          );
    taken.add(variable);
    const setting = variable.slice(prefix.length).toLowerCase();
    return {
      file,
      setting: /^[a-z]/u.test(setting) ? setting : `file_${setting}`,
      variable,
      handle: variable.toLowerCase().replaceAll("_", "-"),
    };
  });
};
