import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { MAVEN_POM_MAX_FILE_BYTES } from "./mavenPom.js";

export const inspectMavenPomInputSchema = z.strictObject({
  path: localPathStringSchema.describe("Absolute path to one local pom.xml"),
  format: z.literal("maven-pom").default("maven-pom"),
  max_file_bytes: z
    .int()
    .positive()
    .max(MAVEN_POM_MAX_FILE_BYTES)
    .default(MAVEN_POM_MAX_FILE_BYTES)
    .describe(
      "Maximum POM bytes read (up to 32 MiB); this does not adjust parser allowances",
    ),
});
export type InspectMavenPomInput = z.output<typeof inspectMavenPomInputSchema>;
