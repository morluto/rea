# Maven POM and Gradle module metadata

`inspect_maven_gradle_metadata` / `inspect-maven-gradle-metadata` reports the
coordinates, dependency declarations, BOM or platform notes, and unresolved
property or parent references written in one selected local Maven `pom.xml` or
Gradle `.module` file. It reads the file without running Maven or Gradle,
resolving a dependency tree, or contacting a repository.

```bash
rea inspect-maven-gradle-metadata /absolute/path/to/pom.xml --json
rea inspect-maven-gradle-metadata /absolute/path/to/demo-1.2.3.module --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_maven_gradle_metadata",
  "arguments": { "path": "/artifacts/pom.xml" }
}
```

Classification is from content, not the suffix: a well-formed Maven `<project>`
document is `maven-pom`; a JSON object with `formatVersion` and a `component`
or `variants` array is `gradle-module`.

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.

`coordinates` holds `group_id`, `artifact_id`, `version`, and `packaging` as
spelled. Missing project coordinates stay `null`. A `${property}` spelling is
kept as written and listed in `unresolved`; this reader does not interpolate
properties or inherit parent or BOM values.

For a POM, `parent` records the declared parent coordinates and `relative_path`
when present. `properties` lists each child of `<properties>` as name and value.
`dependencies` comes from the project's `<dependencies>` list.
`dependency_management` comes from `<dependencyManagement>`. A managed
dependency with `type` `pom` and `scope` `import` is a BOM import
(`bom_import: true`). Each row keeps scope, type, optional, classifier, and
exclusions as present. `version_kind` is `literal`, `range`, `property`, or
`missing`.

For Gradle module metadata, `gradle` records `format_version`,
`created_by_gradle`, and each variant's name, `org.gradle.category`,
`org.gradle.usage`, `available-at` coordinates as spelled, and declared
dependency and constraint counts. Variant dependencies are `origin`
`variant-dependencies`; `dependencyConstraints` are `origin`
`variant-constraints`. Rich versions keep `requires`, `prefers`, `strictly`,
and `rejects`. A variant whose category is `platform` or `enforced-platform`
marks its constraints `platform: true`. `available-at` is not fetched.

`unresolved` names property references, missing coordinates that a parent
would normally supply, and other missing coordinates. These are explicit
unknowns, not guesses.

## Limits and failures

The selected file is limited to 1 MiB by default (16 MiB maximum). Exceeding
the budget fails without partial success. Malformed XML or JSON is
`invalid_format`. A well-formed document that is not a Maven project or Gradle
module metadata file is `unsupported_target`. Document type declarations are
unsupported. External entities are not resolved.

POM profiles, when present, stay unread and unactivated. Declared repositories
stay unread and are not contacted. Packaging is not defaulted to `jar` when
omitted. Gradle variant attributes other than category and usage are not
decoded.

Complete coverage means the selected document was read. It does not establish
a resolved dependency tree, a repository fetch, or that Maven or Gradle would
select the same versions.
