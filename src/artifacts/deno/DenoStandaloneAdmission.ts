import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import type { DenoStandaloneProbe } from "./DenoStandaloneLocation.js";

/** Carrier location belongs to this exact admitted file. */
export interface DenoStandaloneAdmission {
  readonly kind: "deno-standalone";
  readonly source: StableRegularFileDescriptor;
  readonly probe: Extract<DenoStandaloneProbe, { readonly status: "present" }>;
}
