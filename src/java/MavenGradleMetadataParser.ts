import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { findDuplicateJsonMember } from "../domain/jsonDuplicateMember.js";
import { isRecord } from "../kernel/isRecord.js";
import { malformedInput, unsupportedInput } from "../domain/parseFailure.js";
import type { Element, Node } from "@xmldom/xmldom";

import { parseXmlDocument, opensLikeXml } from "../domain/xmlDocument.js";
import {
  MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS,
  MAVEN_GRADLE_METADATA_REPEATED_VARIANT_NAME_CHARS,
  mavenPropertyReferences,
  requestedVersionKind,
  type MavenGradleDependency,
  type MavenGradleMetadata,
  type MavenGradleUnresolved,
} from "../domain/java/mavenGradleMetadata.js";
import { parseRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import {
  MAVEN_GRADLE_METADATA_FORMAT,
  MavenGradleMetadataReportFailure,
} from "./MavenGradleMetadata.errors.js";

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

const MAVEN_POM_NAMESPACE = "http://maven.apache.org/POM/4.0.0";

/**
 * A Maven POM root: `project` in the POM namespace, or a namespace-free
 * `project` that declares `modelVersion` or `artifactId`. Ant and other
 * `project` vocabularies declare neither and are not POMs.
 */
const isMavenProjectRoot = (root: Node | null): root is Element => {
  if (!isElement(root) || root.localName !== "project") return false;
  if (root.namespaceURI === MAVEN_POM_NAMESPACE) return true;
  return (
    (root.namespaceURI === null || root.namespaceURI === "") &&
    childElements(root).some(
      (child) =>
        child.localName === "modelVersion" || child.localName === "artifactId",
    )
  );
};

/** Refuse a report whose rows would outgrow the fixed row allowance. */
const admitDependencyRows = (rows: number): void => {
  if (rows > MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS)
    throw new MavenGradleMetadataReportFailure(
      "dependency_rows",
      MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS,
      rows,
    );
};

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
    // Text (3) and CDATA section (4) nodes both carry character data.
    if (child.nodeType === 3 || child.nodeType === 4)
      parts.push(child.nodeValue ?? "");
  return nonempty(parts.join(""));
};

const childText = (element: Element, local: string): string | null =>
  elementText(firstNamed(element, local));

const textOf = (value: unknown): string | null =>
  typeof value === "string" ? nonempty(value) : null;

const boolOf = (value: string | null): boolean | null => {
  if (value === null) return null;
  const folded = value.toLowerCase();
  if (folded === "true") return true;
  if (folded === "false") return false;
  return null;
};

/** Remove URL userinfo; an unlocatable credential span withholds the whole URL. */
const redactTransportCredentials = (
  value: string | null,
): { url: string | null; url_credentials_redacted: boolean } => {
  if (value === null) return { url: null, url_credentials_redacted: false };
  const { credentials } = parseRecordedTransportUrl(value);
  if (credentials === null)
    return { url: value, url_credentials_redacted: false };
  if (credentials === "ambiguous")
    return { url: null, url_credentials_redacted: true };
  return {
    url: `${value.slice(0, credentials.start)}${value.slice(credentials.end)}`,
    url_credentials_redacted: true,
  };
};

const pushUnresolved = (
  unresolved: MavenGradleUnresolved[],
  entry: MavenGradleUnresolved,
): void => {
  unresolved.push(entry);
};

/** List every property reference in scalar fields whose absence is not a gap. */
const recordPropertyReferences = (
  unresolved: MavenGradleUnresolved[],
  fields: readonly (readonly [MavenGradleUnresolved["field"], string | null])[],
  owner: MavenGradleUnresolved["owner"],
  index: number | null,
): void => {
  for (const [field, value] of fields)
    for (const reference of mavenPropertyReferences(value))
      pushUnresolved(unresolved, {
        kind: "property",
        reference,
        field,
        owner,
        index,
      });
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

/** An absent collection is empty; a present one must be a JSON array. */
const gradleArray = (value: unknown, field: string): readonly unknown[] => {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw malformedInput(
    MAVEN_GRADLE_METADATA_FORMAT,
    `Gradle module metadata ${field} is present but is not a JSON array.`,
  );
};

const gradleObjects = (
  value: unknown,
  field: string,
): readonly Record<string, unknown>[] =>
  gradleArray(value, field).map((entry, index) => {
    if (isRecord(entry)) return entry;
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Gradle module metadata ${field}[${String(index)}] is not a JSON object.`,
    );
  });

const gradleVersionOf = (
  value: unknown,
): MavenGradleDependency["gradle_version"] => {
  if (typeof value === "string") {
    const requires = nonempty(value);
    return requires === null
      ? { ...emptyGradleVersion }
      : { ...emptyGradleVersion, requires };
  }
  if (value === undefined) return { ...emptyGradleVersion };
  if (!isRecord(value))
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata version is present but is neither a string nor a JSON object.",
    );
  const versionText = (field: "requires" | "prefers" | "strictly") => {
    const entry = value[field];
    if (entry === undefined || typeof entry === "string") return textOf(entry);
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Gradle module metadata version.${field} is present but is not a string.`,
    );
  };
  const rejects = gradleArray(value.rejects, "version.rejects").map(
    (entry, index) => {
      const text = textOf(entry);
      if (text !== null) return text;
      throw malformedInput(
        MAVEN_GRADLE_METADATA_FORMAT,
        `Gradle module metadata version.rejects[${String(index)}] is not a non-empty string.`,
      );
    },
  );
  return {
    requires: versionText("requires"),
    prefers: versionText("prefers"),
    strictly: versionText("strictly"),
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
  const classifier = childText(element, "classifier");
  recordPropertyReferences(
    unresolved,
    [
      ["scope", scope],
      ["type", type],
      ["classifier", classifier],
      ["optional", optional_spelling],
    ],
    owner,
    index,
  );
  return {
    group_id,
    artifact_id,
    version,
    version_kind: requestedVersionKind(version, "maven-pom"),
    gradle_version: null,
    scope,
    type,
    optional: boolOf(optional_spelling),
    optional_spelling,
    classifier,
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
    throw parsed.error.kind === "unsupported"
      ? unsupportedInput(
          MAVEN_GRADLE_METADATA_FORMAT,
          "Maven POM declares a document type, which is unsupported.",
        )
      : malformedInput(
          MAVEN_GRADLE_METADATA_FORMAT,
          "Maven POM is not well-formed XML.",
        );
  const root = parsed.value.documentElement;
  if (!isMavenProjectRoot(root))
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
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
  recordPropertyReferences(
    unresolved,
    [["packaging", coordinates.packaging]],
    "project",
    null,
  );
  const propertiesElement = firstNamed(root, "properties");
  const properties =
    propertiesElement === undefined
      ? []
      : childElements(propertiesElement).flatMap((property) => {
          const name = nonempty(property.localName);
          if (name === null) return [];
          // A property may hold a repository URL; its userinfo never leaves the parser.
          const {
            url: value,
            url_credentials_redacted: value_credentials_redacted,
          } = redactTransportCredentials(elementText(property));
          return [{ name, value, value_credentials_redacted }];
        });
  const dependencyManagementElement = firstNamed(root, "dependencyManagement");
  const managedContainer = dependencyManagementElement
    ? firstNamed(dependencyManagementElement, "dependencies")
    : undefined;
  const managedElements =
    managedContainer === undefined
      ? []
      : childrenNamed(managedContainer, "dependency");
  const dependenciesContainer = firstNamed(root, "dependencies");
  const dependencyElements =
    dependenciesContainer === undefined
      ? []
      : childrenNamed(dependenciesContainer, "dependency");
  admitDependencyRows(managedElements.length + dependencyElements.length);
  const dependency_management = managedElements.map((element, index) =>
    parseMavenDependency(element, "dependencyManagement", index, unresolved),
  );
  const dependencies = dependencyElements.map((element, index) =>
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
  if (!isRecord(value))
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Gradle ${origin === "variant-dependencies" ? "dependency" : "dependency constraint"} ${String(index)} is not a JSON object.`,
    );
  const record = value;
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
  const excludes = gradleObjects(record.excludes, "excludes");
  return {
    group_id,
    artifact_id,
    version,
    version_kind: requestedVersionKind(version, "gradle-module"),
    gradle_version,
    scope: null,
    type: null,
    optional: null,
    optional_spelling: null,
    classifier: null,
    exclusions: excludes.map((entry) => ({
      group_id: textOf(entry.group),
      artifact_id: textOf(entry.module),
    })),
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
  } catch {
    // The engine's message quotes source text, which may hold URL credentials.
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata is not well-formed JSON.",
    );
  }
  // JSON.parse keeps the last of a repeated field, which could hide a
  // declaration (for example a second empty `dependencies`) while coverage
  // still read as complete. Refuse the ambiguous document instead.
  const duplicate = findDuplicateJsonMember(source);
  if (duplicate !== undefined)
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Gradle module metadata declares field ${JSON.stringify(duplicate.name)} more than once in one object (offset ${String(duplicate.offset)}).`,
    );
  if (!isRecord(parsed))
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata root must be a JSON object.",
    );
  const format_version = textOf(parsed.formatVersion);
  const component = isRecord(parsed.component) ? parsed.component : null;
  const variantsValue = parsed.variants;
  if (
    format_version === null ||
    (component === null && !Array.isArray(variantsValue))
  )
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
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
  const variants = gradleObjects(variantsValue, "variants");
  admitDependencyRows(
    variants.reduce(
      (rows, variant) =>
        rows +
        gradleArray(variant.dependencies, "dependencies").length +
        gradleArray(variant.dependencyConstraints, "dependencyConstraints")
          .length,
      0,
    ),
  );
  const dependencies: MavenGradleDependency[] = [];
  const dependency_management: MavenGradleDependency[] = [];
  const gradleVariants: NonNullable<MavenGradleMetadata["gradle"]>["variants"] =
    [];
  let nextIndex = 0;
  let repeatedVariantNameChars = 0;
  for (const variant of variants) {
    const name = textOf(variant.name);
    const attributes = isRecord(variant.attributes) ? variant.attributes : {};
    const category = textOf(attributes["org.gradle.category"]);
    const usage = textOf(attributes["org.gradle.usage"]);
    const platform =
      category === "platform" || category === "enforced-platform";
    const availableAt: unknown = variant["available-at"];
    if (availableAt !== undefined && !isRecord(availableAt))
      throw malformedInput(
        MAVEN_GRADLE_METADATA_FORMAT,
        "Gradle module metadata available-at is present but is not a JSON object.",
      );
    const available = availableAt === undefined ? null : availableAt;
    const variantDependencies = gradleArray(
      variant.dependencies,
      "dependencies",
    );
    const constraints = gradleArray(
      variant.dependencyConstraints,
      "dependencyConstraints",
    );
    // Every row repeats its variant's name; admit that expansion before
    // building rows, so a long name times many rows cannot outgrow the input.
    repeatedVariantNameChars +=
      (name?.length ?? 0) * (variantDependencies.length + constraints.length);
    if (
      repeatedVariantNameChars >
      MAVEN_GRADLE_METADATA_REPEATED_VARIANT_NAME_CHARS
    )
      throw new MavenGradleMetadataReportFailure(
        "repeated_variant_name_chars",
        MAVEN_GRADLE_METADATA_REPEATED_VARIANT_NAME_CHARS,
        repeatedVariantNameChars,
      );
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
              ...redactTransportCredentials(textOf(available.url)),
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
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Selected artifact length disagrees with the retained bytes.",
    );
  if (bytes.length === 0)
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Selected file is empty.",
    );
  let source: string;
  try {
    // ignoreBOM: true kept a leading U+FEFF; "preserve" is that same policy.
    source = decodeStrictUtf8(bytes, "preserve");
  } catch {
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Selected file is not valid UTF-8.",
    );
  }
  const trimmed = source.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    return parseGradle(source, artifact);
  if (opensLikeXml(trimmed) || trimmed.startsWith("<"))
    return parsePom(source, artifact);
  throw unsupportedInput(
    MAVEN_GRADLE_METADATA_FORMAT,
    "Selected file is not a Maven POM or Gradle module-metadata document.",
  );
};
