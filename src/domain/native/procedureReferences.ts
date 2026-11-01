import { z } from "zod";
import { procedureIdentitySchema } from "./procedureInfo.js";
import {
  referenceEdgeSchema,
  unresolvedCallSchema,
} from "./nativeReference.js";

/** Complete provider-observed references and unresolved calls for one procedure. */
export const procedureReferencesSchema = z.object({
  procedure: procedureIdentitySchema,
  direction: z.enum(["incoming", "outgoing"]),
  reference_kinds_available: z.boolean(),
  unresolved_calls: z.array(unresolvedCallSchema),
  references: z.array(referenceEdgeSchema),
});
