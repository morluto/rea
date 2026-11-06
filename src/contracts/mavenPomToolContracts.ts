import { mavenPomSchema } from "../domain/mavenPom/mavenPom.js";
import { inspectMavenPomInputSchema } from "../domain/mavenPom/mavenPomQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for declarations in one local Maven POM. */
export const MAVEN_POM_TOOL_CONTRACTS = [
  {
    name: "inspect_maven_pom",
    ...toolContractMetadata("inspect_maven_pom"),
    kind: "application",
    description:
      "Inventory declared coordinates, dependencies, dependency management, properties, profiles and repositories in one local pom.xml offline. Maven, Gradle, plugins and build scripts stay untouched; there is no repository or network access, and no parent POM, imported BOM or transitive dependency is fetched. Dependency-management versions are reported as declarations that manage an omitted version, never as resolutions. Property references stay explicit instead of being interpolated, and profile activation conditions are reported without being evaluated. Document type declarations and external entities are rejected before parsing. File and retained-facts allowances are each 32 MiB.",
    inputSchema: inspectMavenPomInputSchema,
    outputSchema: evidenceResultOf(mavenPomSchema),
    examples: [
      {
        title: "Read a POM's declared dependencies without building it",
        input: { path: "/artifacts/service/pom.xml" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
