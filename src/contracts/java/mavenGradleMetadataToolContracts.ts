import {
  inspectMavenGradleMetadataInputSchema,
  mavenGradleMetadataSchema,
} from "../../domain/java/mavenGradleMetadata.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Static Maven POM and Gradle module metadata inspection is independent of active native-analysis providers. */
export const MAVEN_GRADLE_METADATA_TOOL_CONTRACTS = [
  {
    name: "inspect_maven_gradle_metadata",
    ...toolContractMetadata("inspect_maven_gradle_metadata"),
    kind: "artifact-provider",
    description:
      "Inspect a local Maven pom.xml or Gradle .module metadata file as static bytes, without running Maven or Gradle, resolving a dependency tree, or contacting a repository. Returns artifact identity, coordinates as spelled, parent and property declarations, dependency and dependencyManagement rows (scope, type, optional, classifier, exclusions, BOM import), Gradle variants and rich versions, and unresolved property or parent-coordinate references as explicit unknowns. Classification is from content, not the suffix. Malformed XML/JSON fails closed; unrecognized documents are unsupported. Resource refusals remain explicit.",
    inputSchema: inspectMavenGradleMetadataInputSchema,
    outputSchema: evidenceResultOf(mavenGradleMetadataSchema),
    examples: [
      {
        title: "Read declared Maven coordinates and a BOM import",
        input: { path: "/artifacts/pom.xml" },
      },
      {
        title: "Read Gradle module variants and version constraints",
        input: { path: "/artifacts/demo-1.2.3.module" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
