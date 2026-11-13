import type { Element, Node } from "@xmldom/xmldom";

import { parseXmlDocument, opensLikeXml } from "../domain/xmlDocument.js";
import {
  mavenPropertyReferences,
  mavenRequestedVersionKind,
  type MavenGradleDependency,
  type MavenGradleMetadata,
  type MavenGradleUnresolved,
} from "../domain/java/mavenGradleMetadata.js";
import { MavenGradleMetadataFormatFailure } from "./MavenGradleMetadata.errors.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const BASE_LIMITATIONS = [
  "This workflow reads a Maven POM or Gradle module-metadata document without running Maven or Gradle, resolving a dependency tree, or contacting a repository.",
  "Requested versions, ranges, and property spellings are recorded as written; interpolation and parent/BOM inheritance are not performed.",
] as const;

const isElement = (node: Node | null): node is Element =>
  node !== null && node.nodeType === 1;

const childElements = (element: Element): Element[] => {
  const children: Element[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  )
    if (isElement(child)) children.push(child);
  return children;
};

const childrenNamed = (element: Element, local: string): Element[] =>
  childElements(element).filter((child) => child.localName === local);

const firstNamed = (element: Element, local: string): Element | undefined =>
  childrenNamed(element, local)[0];

const nonempty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const elementText = (element: Element | undefined): string | null => {
  if (element === undefined) return null;
  const parts: string[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  )
    if (child.nodeType === 3) parts.push(child.nodeValue ?? "");
  return nonempty(parts.join(""));
};

const childText = (element: Element, local: string): string | null =>
  elementText(firstNamed(element, local));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | null =>
  typeof value === "string" ? nonempty(value) : null;

const boolOf = (value: string | null): boolean | null => {
  if (value === null) return null;
  const folded = value.toLowerCase();
  if (folded === "true") return true;
  if (folded === "false") return false;
  return null;
};

const pushUnresolved = (
  unresolved: MavenGradleUnresolved[],
  entry: MavenGradleUnresolved,
): void => {
  unresolved.push(entry);
};

const recordCoordinateGaps = (
  unresolved: MavenGradleUnresolved[],
  coordinates: {
    group_id: string | null;
    artifact_id: string | null;
    version: string | null;
  },
  owner: MavenGradleUnresolved["owner"],
  index: number | null,
  parentPresent: boolean,
): void => {
  const fields = [
    ["group_id", coordinates.group_id],
    ["artifact_id", coordinates.artifact_id],
    ["version", coordinates.version],
  ] as const;
  for (const [field, value] of fields) {
    const properties = mavenPropertyReferences(value);
    if (properties.length > 0) {
      for (const reference of properties)
        pushUnresolved(unresolved, {
          kind: "property",
          reference,
          field,
          owner,
          index,
        });
      continue;
    }
    if (value !== null) continue;
    pushUnresolved(unresolved, {
      kind: parentPresent ? "parent-coordinate" : "missing-coordinate",
      reference: parentPresent ? `parent.${field}` : `${owner}.${field}`,
      field,
      owner,
      index,
    });
  }
};

const emptyGradleVersion = {
  requires: null,
  prefers: null,
  strictly: null,
  rejects: [] as string[],
};

const gradleVersionOf = (
  value: unknown,
): MavenGradleDependency["gradle_version"] => {
  if (typeof value === "string") {
    const requires = nonempty(value);
    return requires === null
      ? { ...emptyGradleVersion }
      : { ...emptyGradleVersion, requires };
  }
  if (!isRecord(value)) return { ...emptyGradleVersion };
  const rejects = Array.isArray(value.rejects)
    ? value.rejects.flatMap((entry) => {
        const text = textOf(entry);
        return text === null ? [] : [text];
      })
    : [];
  return {
    requires: textOf(value.requires),
    prefers: textOf(value.prefers),
    strictly: textOf(value.strictly),
    rejects,
  };
};

const requestedFromGradle = (
  version: MavenGradleDependency["gradle_version"],
): string | null => {
  if (version === null) return null;
  return version.requires ?? version.strictly ?? version.prefers;
};

const parseMavenDependency = (
  element: Element,
  origin: "dependencies" | "dependencyManagement",
  index: number,
  unresolved: MavenGradleUnresolved[],
): MavenGradleDependency => {
  const group_id = childText(element, "groupId");
  const artifact_id = childText(element, "artifactId");
  const version = childText(element, "version");
  const type = childText(element, "type");
  const scope = childText(element, "scope");
  const bom_import = type === "pom" && scope === "import";
  const exclusionsContainer = firstNamed(element, "exclusions");
  const exclusions =
    exclusionsContainer === undefined
      ? []
      : childrenNamed(exclusionsContainer, "exclusion").map((exclusion) => ({
          group_id: childText(exclusion, "groupId"),
          artifact_id: childText(exclusion, "artifactId"),
        }));
  const owner =
    origin === "dependencies" ? "dependency" : "dependency_management";
  recordCoordinateGaps(
    unresolved,
    { group_id, artifact_id, version },
    owner,
    index,
    false,
  );
  const optional_spelling = childText(element, "optional");
  for (const reference of mavenPropertyReferences(optional_spelling))
    pushUnresolved(unresolved, {
      kind: "property",
      reference,
      field: "optional",
      owner,
      index,
    });
  return {
    group_id,
    artifact_id,
    version,
    version_kind: mavenRequestedVersionKind(version),
    gradle_version: null,
    scope,
    type,
    optional: boolOf(optional_spelling),
    optional_spelling,
    classifier: childText(element, "classifier"),
    exclusions,
    origin,
    variant: null,
    bom_import,
    platform: false,
  };
};

const parsePom = (
  xml: string,
  artifact: { path: string; sha256: string; bytes: number },
): MavenGradleMetadata => {
  const limitations: string[] = [...BASE_LIMITATIONS];
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    throw new MavenGradleMetadataFormatFailure(
      parsed.error.reason === "doctype" ? "unsupported" : "malformed",
      parsed.error.reason === "doctype"
        ? "Maven POM declares a document type, which is unsupported."
        : "Maven POM is not well-formed XML.",
    );
  const root = parsed.value.documentElement;
  if (!isElement(root) || root.localName !== "project")
    throw new MavenGradleMetadataFormatFailure(
      "unsupported",
      "Selected XML document is not a Maven project POM.",
    );
  const unresolved: MavenGradleUnresolved[] = [];
  const parentElement = firstNamed(root, "parent");
  const parent =
    parentElement === undefined
      ? null
      : {
          group_id: childText(parentElement, "groupId"),
          artifact_id: childText(parentElement, "artifactId"),
          version: childText(parentElement, "version"),
          packaging: null,
          relative_path: childText(parentElement, "relativePath"),
          relative_path_declared:
            firstNamed(parentElement, "relativePath") !== undefined,
        };
  if (parent !== null)
    recordCoordinateGaps(unresolved, parent, "parent", null, false);
  const coordinates = {
    group_id: childText(root, "groupId"),
    artifact_id: childText(root, "artifactId"),
    version: childText(root, "version"),
    packaging: childText(root, "packaging"),
  };
  recordCoordinateGaps(
    unresolved,
    coordinates,
    "project",
    null,
    parent !== null,
  );
  const propertiesElement = firstNamed(root, "properties");
  const properties =
    propertiesElement === undefined
      ? []
      : childElements(propertiesElement).flatMap((property) => {
          const name = nonempty(property.localName);
          return name === null ? [] : [{ name, value: elementText(property) }];
        });
  const dependencyManagementElement = firstNamed(root, "dependencyManagement");
  const managedContainer = dependencyManagementElement
    ? firstNamed(dependencyManagementElement, "dependencies")
    : undefined;
  const dependency_management = (
    managedContainer === undefined
      ? []
      : childrenNamed(managedContainer, "dependency")
  ).map((element, index) =>
    parseMavenDependency(element, "dependencyManagement", index, unresolved),
  );
  const dependenciesContainer = firstNamed(root, "dependencies");
  const dependencies = (
    dependenciesContainer === undefined
      ? []
      : childrenNamed(dependenciesContainer, "dependency")
  ).map((element, index) =>
    parseMavenDependency(element, "dependencies", index, unresolved),
  );
  if (parent !== null)
    limitations.push(
      "Parent coordinates are recorded as spelled; the parent POM was not read and inheritance was not applied.",
    );
  if (firstNamed(root, "repositories") !== undefined)
    limitations.push(
      "Declared repositories are recorded as unread; they were not contacted.",
    );
  if (firstNamed(root, "profiles") !== undefined)
    limitations.push(
      "POM profiles are present and were not activated; profile-scoped declarations remain unread.",
    );
  if (coordinates.packaging === null)
    limitations.push(
      "Packaging was not declared; Maven would default to jar, but that default was not applied.",
    );
  return {
    artifact: {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
    format: "maven-pom",
    coordinates,
    parent,
    properties,
    dependencies,
    dependency_management,
    gradle: null,
    unresolved,
    coverage: { status: "complete", examined_bytes: artifact.bytes },
    limitations,
  };
};

const parseGradleDependency = (
  value: unknown,
  origin: "variant-dependencies" | "variant-constraints",
  variant: string | null,
  platform: boolean,
  index: number,
  unresolved: MavenGradleUnresolved[],
): MavenGradleDependency => {
  const record = isRecord(value) ? value : {};
  const group_id = textOf(record.group);
  const artifact_id = textOf(record.module);
  const gradle_version = gradleVersionOf(record.version);
  const version = requestedFromGradle(gradle_version);
  recordCoordinateGaps(
    unresolved,
    { group_id, artifact_id, version },
    "variant",
    index,
    false,
  );
  const excludes = Array.isArray(record.excludes) ? record.excludes : [];
  return {
    group_id,
    artifact_id,
    version,
    version_kind: mavenRequestedVersionKind(version),
    gradle_version,
    scope: null,
    type: null,
    optional: null,
    optional_spelling: null,
    classifier: null,
    exclusions: excludes.flatMap((entry) =>
      isRecord(entry)
        ? [
            {
              group_id: textOf(entry.group),
              artifact_id: textOf(entry.module),
            },
          ]
        : [],
    ),
    origin,
    variant,
    bom_import: false,
    platform,
  };
};

const parseGradle = (
  source: string,
  artifact: { path: string; sha256: string; bytes: number },
): MavenGradleMetadata => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause: unknown) {
    throw new MavenGradleMetadataFormatFailure(
      "malformed",
      `Gradle module metadata is not well-formed JSON${
        cause instanceof Error ? `: ${cause.message}` : "."
      }`,
    );
  }
  if (!isRecord(parsed))
    throw new MavenGradleMetadataFormatFailure(
      "unsupported",
      "Gradle module metadata root must be a JSON object.",
    );
  const format_version = textOf(parsed.formatVersion);
  const component = isRecord(parsed.component) ? parsed.component : null;
  const variantsValue = parsed.variants;
  if (
    format_version === null ||
    (component === null && !Array.isArray(variantsValue))
  )
    throw new MavenGradleMetadataFormatFailure(
      "unsupported",
      "Selected JSON document is not Gradle module metadata (missing formatVersion and component or variants).",
    );
  const limitations: string[] = [
    ...BASE_LIMITATIONS,
    "Gradle variant attributes other than category and usage are not decoded.",
    "available-at coordinates are recorded as spelled; the named module file was not fetched.",
  ];
  const unresolved: MavenGradleUnresolved[] = [];
  const coordinates = {
    group_id: component === null ? null : textOf(component.group),
    artifact_id: component === null ? null : textOf(component.module),
    version: component === null ? null : textOf(component.version),
    packaging: null,
  };
  recordCoordinateGaps(unresolved, coordinates, "project", null, false);
  const createdBy = isRecord(parsed.createdBy) ? parsed.createdBy : null;
  const createdGradle =
    createdBy !== null && isRecord(createdBy.gradle) ? createdBy.gradle : null;
  const variants = Array.isArray(variantsValue) ? variantsValue : [];
  const dependencies: MavenGradleDependency[] = [];
  const dependency_management: MavenGradleDependency[] = [];
  const gradleVariants: NonNullable<MavenGradleMetadata["gradle"]>["variants"] =
    [];
  let nextIndex = 0;
  for (const variantValue of variants) {
    const variant = isRecord(variantValue) ? variantValue : {};
    const name = textOf(variant.name);
    const attributes = isRecord(variant.attributes) ? variant.attributes : {};
    const category = textOf(attributes["org.gradle.category"]);
    const usage = textOf(attributes["org.gradle.usage"]);
    const platform =
      category === "platform" || category === "enforced-platform";
    const available = isRecord(variant["available-at"])
      ? variant["available-at"]
      : null;
    const variantDependencies = Array.isArray(variant.dependencies)
      ? variant.dependencies
      : [];
    const constraints = Array.isArray(variant.dependencyConstraints)
      ? variant.dependencyConstraints
      : [];
    for (const dependency of variantDependencies)
      dependencies.push(
        parseGradleDependency(
          dependency,
          "variant-dependencies",
          name,
          platform,
          nextIndex++,
          unresolved,
        ),
      );
    for (const constraint of constraints)
      dependency_management.push(
        parseGradleDependency(
          constraint,
          "variant-constraints",
          name,
          platform,
          nextIndex++,
          unresolved,
        ),
      );
    gradleVariants.push({
      name,
      category,
      usage,
      available_at:
        available === null
          ? null
          : {
              group_id: textOf(available.group),
              artifact_id: textOf(available.module),
              version: textOf(available.version),
              url: textOf(available.url),
            },
      dependency_count: variantDependencies.length,
      constraint_count: constraints.length,
    });
  }
  return {
    artifact: {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
    format: "gradle-module",
    coordinates,
    parent: null,
    properties: [],
    dependencies,
    dependency_management,
    gradle: {
      format_version,
      created_by_gradle:
        createdGradle === null ? null : textOf(createdGradle.version),
      variants: gradleVariants,
    },
    unresolved,
    coverage: { status: "complete", examined_bytes: artifact.bytes },
    limitations,
  };
};

/** Decode one bounded Maven POM or Gradle module-metadata document without resolution. */
export const parseMavenGradleMetadata = (
  bytes: Uint8Array,
  artifact: { path: string; sha256: string; bytes: number },
): MavenGradleMetadata => {
  if (bytes.length !== artifact.bytes)
    throw new MavenGradleMetadataFormatFailure(
      "malformed",
      "Selected artifact length disagrees with the retained bytes.",
    );
  if (bytes.length === 0)
    throw new MavenGradleMetadataFormatFailure(
      "malformed",
      "Selected file is empty.",
    );
  let source: string;
  try {
    source = UTF8.decode(bytes);
  } catch {
    throw new MavenGradleMetadataFormatFailure(
      "malformed",
      "Selected file is not valid UTF-8.",
    );
  }
  const trimmed = source.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    return parseGradle(source, artifact);
  if (opensLikeXml(trimmed) || trimmed.startsWith("<"))
    return parsePom(source, artifact);
  throw new MavenGradleMetadataFormatFailure(
    "unsupported",
    "Selected file is not a Maven POM or Gradle module-metadata document.",
  );
};
