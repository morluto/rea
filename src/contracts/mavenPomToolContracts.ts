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

/**
 * Representative result shape for the tool contract, documented in
 * `docs/mcp-contracts.md` so callers can read version origins, coverage and
 * limits without running the tool. Paths and documents are shortened.
 */
export const MAVEN_POM_RESULT_EXAMPLE = {
  format: "maven-pom",
  model_version: "4.0.0",
  project: {
    group_id: "com.example",
    artifact_id: "service",
    version: "0.1.0",
    packaging: null,
  },
  dependencies: [
    {
      group_id: "org.slf4j",
      artifact_id: "slf4j-api",
      version: null,
      version_origin: { kind: "managed", managed_by: "dependencyManagement" },
      declared_by: "dependencies",
      scope: "compile",
      optional: null,
      type: null,
      classifier: null,
      profile: null,
      source_pointer: "/project/dependencies[0]/dependency[0]",
    },
    {
      group_id: "org.junit.jupiter",
      artifact_id: "junit-jupiter",
      version: "${junit.version}",
      version_origin: { kind: "property" },
      declared_by: "dependencies",
      scope: "test",
      optional: null,
      type: null,
      classifier: null,
      profile: null,
      source_pointer: "/project/dependencies[0]/dependency[1]",
    },
  ],
  properties: [
    {
      name: "junit.version",
      value: "5.10.2",
      source_pointer: "/project/properties[0]/junit.version[0]",
    },
  ],
  property_references: [
    {
      name: "junit.version",
      declared: "5.10.2",
      resolution: "resolved",
      resolved: "5.10.2",
      source_pointer: "/project/properties[0]/junit.version[0]",
    },
  ],
  summary: {
    dependencies: 2,
    dependency_management: 1,
    managed_dependencies: 1,
    profile_dependencies: 0,
    unresolved_versions: 1,
  },
  source_coverage: {
    parent_pom: "not-read",
    bom_imports: "not-resolved",
    transitive_dependencies: "not-resolved",
    profile_activation: "declarations-only",
  },
} as const;
