# Inspect Maven POM and Gradle module metadata

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the
[current guide](../../../maven-gradle-metadata.md).

## Outcome

Java dependency declarations often live outside a JAR, in a Maven POM or a
Gradle module-metadata file. Looking only at archive contents misses declared
coordinates, BOM imports, version ranges, exclusions, and variant constraints.

`rea inspect-maven-gradle-metadata <path>` reads one explicitly selected POM or
`.module` file as static bytes and reports coordinates, dependency
declarations, BOM or platform notes, and unresolved property or parent
references, without running Maven or Gradle, resolving a tree, or contacting a
repository. The same facts are available through the
`inspect_maven_gradle_metadata` MCP tool.

## Requirements

- Classification is from content, not the suffix.
- Coordinates, packaging, parent, properties, dependencies, dependencyManagement,
  exclusions, BOM imports, and version ranges are recorded as spelled.
- Gradle variants, rich versions, constraints, and `available-at` coordinates
  are recorded as spelled; named module files are not fetched.
- Property spellings and missing parent-inherited coordinates remain explicit
  unknowns. Interpolation and inheritance are not performed.
- Malformed XML/JSON fails closed. Unrecognized documents are unsupported.
  Document types are rejected. No network is used.

## Non-goals

- Resolving a dependency tree or selecting versions.
- Running Maven or Gradle, executing plugins, or reading a credential store.
- Comparing two metadata snapshots.
- Associating metadata with a JAR or AAR.
- Activating POM profiles or applying packaging defaults.

## Verification

- Parser fixtures cover a parent POM with properties, a BOM import, an
  exclusion, a version range, and a Gradle 1.1 module with library and platform
  variants.
- CLI, MCP, and absolute-path boundary contracts have their own tests.
