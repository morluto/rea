import { satisfies, valid } from "semver";
import {
  WABT_ACCEPTED_RANGE,
  WABT_RELEASE_LINE,
  WABT_VERSION,
} from "../domain/wasm/wasmArtifact.js";

export const WABT_PROVIDER_IDENTITY = {
  id: "wabt-artifact",
  name: "REA WABT artifact adapter",
  version: `wabt@${WABT_VERSION}`,
} as const;

/** Admission of the banners reported by one configured WABT tool directory. */
export type WabtVersionAdmission =
  | { readonly status: "verified"; readonly version: string }
  | {
      readonly status: "compatible";
      readonly version: string;
      readonly limitation: string;
    }
  | { readonly status: "unsupported"; readonly message: string };

/**
 * Release warning for inspections that did not reach a report. Successful
 * reports carry the same text through the admission limitation, so a failure
 * never drops the compatible-release disclaimer that a success would state.
 */
export const wabtReleaseLimitation = (version: string): string =>
  `This inspection uses caller-supplied WABT ${version}. REA verified the tool arguments and output parsing against ${WABT_VERSION}; other releases in ${WABT_ACCEPTED_RANGE} are admitted and the observed banner is reported.`;

/** Classify one `--version` banner against the accepted release range. */
export const admitWabtVersion = (banner: string): WabtVersionAdmission => {
  const token = banner.trim();
  if (valid(token) !== token || !satisfies(token, WABT_ACCEPTED_RANGE))
    return {
      status: "unsupported",
      message: `Unsupported WABT version ${token.length === 0 ? "banner" : token}; accepted releases are ${WABT_RELEASE_LINE}`,
    };
  if (token === WABT_VERSION) return { status: "verified", version: token };
  return {
    status: "compatible",
    version: token,
    limitation: wabtReleaseLimitation(token),
  };
};
