import { MavenGradleUnresolvedCollector } from "./MavenGradleUnresolvedCollector.js";
import { Budget } from "../domain/budget.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { parseJsonWithDuplicatePolicy } from "../domain/jsonDuplicateMember.js";
import { isRecord } from "../kernel/isRecord.js";
import { malformedInput, unsupportedInput } from "../domain/parseFailure.js";
import type { Element, Node } from "@xmldom/xmldom";

import {
  parseXmlDocumentWithinNodeLimit,
  opensLikeXml,
} from "../domain/xmlDocument.js";
import {
  MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS,
  MAVEN_GRADLE_METADATA_EXCLUSIONS,
  MAVEN_GRADLE_METADATA_REPEATED_VARIANT_NAME_CHARS,
  MAVEN_GRADLE_METADATA_VARIANTS,
  MAVEN_GRADLE_METADATA_XML_NODES,
  requestedVersionKind,
  type MavenGradleDependency,
  type MavenGradleMetadata,
} from "../domain/java/mavenGradleMetadata.js";
import { redactRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import {
  MAVEN_GRADLE_METADATA_FORMAT,
  metadataReportLimit,
  type MavenGradleReportAllowance,
} from "./MavenGradleMetadata.errors.js";

const BASE_LIMITATIONS = [
  "This workflow reads a Maven POM or Gradle module-metadata document without running Maven or Gradle, resolving a dependency tree, or contacting a repository.",
  "Requested versions, ranges, and property spellings are recorded as written; interpolation and parent/BOM inheritance are not performed.",
] as const;

const GRADLE_MODULE_METADATA_VERSION = "1.1";

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

const childrenNamed = (element: Element, ...names: string[]): Element[] => {
  const ns = element.namespaceURI ?? "";
  const matches: Element[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (
      isElement(child) &&
      (child.namespaceURI ?? "") === ns &&
      child.localName !== null &&
      names.includes(child.localName)
    )
      matches.push(child);
  }
  return matches;
};

const soleNamed = (element: Element, local: string): Element | undefined => {
  const ns = element.namespaceURI ?? "";
  let found: Element | undefined;
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (
      isElement(child) &&
      (child.namespaceURI ?? "") === ns &&
      child.localName === local
    ) {
      if (found !== undefined)
        throw malformedInput(
          MAVEN_GRADLE_METADATA_FORMAT,
          `Maven POM declares <${local}> more than once in one <${element.localName}>.`,
        );
      found = child;
    }
  }
  return found;
};

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
    childrenNamed(root, "modelVersion", "artifactId").length > 0
  );
};

/** Refuse a report whose expanded collection would outgrow its fixed allowance. */
const admit = (
  allowance: MavenGradleReportAllowance,
  limit: number,
  required: number,
): void => {
  if (required > limit) throw metadataReportLimit(allowance, limit, required);
};

/** Maven coordinates and property values are text declarations, not XML trees. */
const mavenText = (element: Element): string | null => {
  const parts: string[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (isElement(child))
      throw malformedInput(
        MAVEN_GRADLE_METADATA_FORMAT,
        `Maven POM <${element.tagName}> must contain text without nested elements.`,
      );
    // Text (3) and CDATA section (4) nodes both carry character data.
    if (child.nodeType === 3 || child.nodeType === 4)
      parts.push(child.nodeValue ?? "");
  }
  const text = parts.join("");
  // Maven's model reader applies Java String.trim() to scalar declarations,
  // including property values. Non-ASCII edge characters remain part of them.
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return start === end ? null : text.slice(start, end);
};

const childText = (element: Element, local: string): string | null => {
  const child = soleNamed(element, local);
  return child === undefined ? null : mavenText(child);
};

/** Keep Gradle JSON spelling for Evidence and exact comparisons. */
const gradleText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const boolOf = (value: string | null): boolean | null => {
  if (value === null) return null;
  const folded = value.toLowerCase();
  if (folded === "true") return true;
  if (folded === "false") return false;
  return null;
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

const gradleObject = (
  value: unknown,
  field: string,
): Record<string, unknown> | null => {
  if (value === undefined) return null;
  if (isRecord(value)) return value;
  throw malformedInput(
    MAVEN_GRADLE_METADATA_FORMAT,
    `Gradle module metadata ${field} is present but is not a JSON object.`,
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
    return { ...emptyGradleVersion, requires: gradleText(value) };
  }
  if (value === undefined) return { ...emptyGradleVersion };
  if (!isRecord(value))
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata version is present but is neither a string nor a JSON object.",
    );
  const versionText = (field: "requires" | "prefers" | "strictly") => {
    const entry = value[field];
    if (entry === undefined || typeof entry === "string")
      return gradleText(entry);
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Gradle module metadata version.${field} is present but is not a string.`,
    );
  };
  const rejects = gradleArray(value.rejects, "version.rejects").map(
    (entry, index) => {
      const text = gradleText(entry);
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

/** The `<exclusion>` elements of one POM dependency row. */
const mavenExclusionElements = (element: Element): Element[] => {
  const container = soleNamed(element, "exclusions");
  return container === undefined ? [] : childrenNamed(container, "exclusion");
};

const parseMavenDependency = <
  Origin extends "dependencies" | "dependencyManagement",
>(
  element: Element,
  origin: Origin,
  index: number,
  unresolved: MavenGradleUnresolvedCollector,
): MavenGradleDependency<Origin> => {
  const group_id = childText(element, "groupId");
  const artifact_id = childText(element, "artifactId");
  const version = childText(element, "version");
  const type = childText(element, "type");
  const scope = childText(element, "scope");
  const bom_import =
    origin === "dependencyManagement" && type === "pom" && scope === "import";
  const exclusions = mavenExclusionElements(element).map((exclusion) => ({
    group_id: childText(exclusion, "groupId"),
    artifact_id: childText(exclusion, "artifactId"),
  }));
  const owner =
    origin === "dependencies" ? "dependency" : "dependency_management";
  unresolved.coordinates(
    { group_id, artifact_id, version },
    owner,
    index,
    false,
  );
  const optional_spelling = childText(element, "optional");
  const classifier = childText(element, "classifier");
  unresolved.properties(
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
  // Maven applies XML 1.0 end-of-line handling to property and coordinate text.
  const parsed = parseXmlDocumentWithinNodeLimit(xml, {
    lineEndings: "normalize",
    maximumNodes: MAVEN_GRADLE_METADATA_XML_NODES,
  });
  if (!parsed.ok && parsed.error.kind === "node-limit")
    throw metadataReportLimit(
      "xml_nodes",
      parsed.error.maximum,
      parsed.error.required,
    );
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
  const unresolved = new MavenGradleUnresolvedCollector();
  const parentElement = soleNamed(root, "parent");
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
            soleNamed(parentElement, "relativePath") !== undefined,
        };
  if (parent !== null) unresolved.coordinates(parent, "parent", null, false);
  const coordinates = {
    group_id: childText(root, "groupId"),
    artifact_id: childText(root, "artifactId"),
    version: childText(root, "version"),
    packaging: childText(root, "packaging"),
  };
  unresolved.coordinates(coordinates, "project", null, parent !== null);
  unresolved.properties(
    [["packaging", coordinates.packaging]],
    "project",
    null,
  );
  const propertiesElement = soleNamed(root, "properties");
  const properties =
    propertiesElement === undefined
      ? []
      : childElements(propertiesElement).map((property) => {
          // A property may hold a repository URL; its userinfo never leaves the parser.
          const {
            url: value,
            url_credentials_redacted: value_credentials_redacted,
          } = redactRecordedTransportUrl(mavenText(property));
          // Maven property keys are the written qualified names, not XML
          // expanded names: different prefixes remain different keys.
          return { name: property.tagName, value, value_credentials_redacted };
        });
  const dependencyManagementElement = soleNamed(root, "dependencyManagement");
  const managedContainer = dependencyManagementElement
    ? soleNamed(dependencyManagementElement, "dependencies")
    : undefined;
  const managedElements =
    managedContainer === undefined
      ? []
      : childrenNamed(managedContainer, "dependency");
  const dependenciesContainer = soleNamed(root, "dependencies");
  const dependencyElements =
    dependenciesContainer === undefined
      ? []
      : childrenNamed(dependenciesContainer, "dependency");
  admit(
    "dependency_rows",
    MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS,
    managedElements.length + dependencyElements.length,
  );
  admit(
    "exclusions",
    MAVEN_GRADLE_METADATA_EXCLUSIONS,
    [...managedElements, ...dependencyElements].reduce(
      (count, element) => count + mavenExclusionElements(element).length,
      0,
    ),
  );
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
  if (soleNamed(root, "repositories") !== undefined)
    limitations.push(
      "Declared repositories are recorded as unread; they were not contacted.",
    );
  if (soleNamed(root, "profiles") !== undefined)
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
    unresolved: unresolved.finish(),
    coverage: { status: "complete", examined_bytes: artifact.bytes },
    limitations,
  };
};

const parseGradleDependency = <
  Origin extends "variant-dependencies" | "variant-constraints",
>(
  value: unknown,
  origin: Origin,
  variant: string | null,
  platform: boolean,
  index: number,
  unresolved: MavenGradleUnresolvedCollector,
): MavenGradleDependency<Origin> => {
  if (!isRecord(value))
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Gradle ${origin === "variant-dependencies" ? "dependency" : "dependency constraint"} ${String(index)} is not a JSON object.`,
    );
  const record = value;
  const group_id = gradleText(record.group);
  const artifact_id = gradleText(record.module);
  const gradle_version = gradleVersionOf(record.version);
  const version = requestedFromGradle(gradle_version);
  unresolved.coordinates(
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
      group_id: gradleText(entry.group),
      artifact_id: gradleText(entry.module),
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
  const json = parseJsonWithDuplicatePolicy(source, "reject");
  if (!json.ok) {
    if (json.duplicate !== undefined)
      throw malformedInput(
        MAVEN_GRADLE_METADATA_FORMAT,
        `Gradle module metadata declares a field more than once in one object (offset ${String(json.duplicate.offset)}).`,
      );
    // Engine diagnostics can quote credential-bearing source; keep the public reason generic.
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata is not well-formed JSON.",
      { cause: json.cause },
    );
  }
  const parsed = json.value;
  if (!isRecord(parsed))
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata root must be a JSON object.",
    );
  const format_version = gradleText(parsed.formatVersion);
  if (format_version === null)
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Selected JSON document is not Gradle module metadata (missing a string formatVersion).",
    );
  if (json.firstObjectMember !== "formatVersion")
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Gradle module metadata formatVersion must be the first object member.",
    );
  const component = gradleObject(parsed.component, "component");
  const variantsValue = parsed.variants;
  const knownVersion = format_version === GRADLE_MODULE_METADATA_VERSION;
  if (!knownVersion && component === null && !Array.isArray(variantsValue))
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Unrecognized Gradle module metadata formatVersion without component or variants.",
    );
  const limitations: string[] = [
    ...BASE_LIMITATIONS,
    "Gradle variant attributes other than category and usage are not decoded.",
    "available-at coordinates are recorded as spelled; the named module file was not fetched.",
  ];
  if (!knownVersion)
    limitations.push(
      `Recognized fields in this unfamiliar format version were interpreted using Gradle module metadata ${GRADLE_MODULE_METADATA_VERSION}. Version-specific declarations may be unreported.`,
    );
  const unresolved = new MavenGradleUnresolvedCollector();
  const coordinates = {
    group_id: component === null ? null : gradleText(component.group),
    artifact_id: component === null ? null : gradleText(component.module),
    version: component === null ? null : gradleText(component.version),
    packaging: null,
  };
  unresolved.coordinates(coordinates, "project", null, false);
  const createdBy = gradleObject(parsed.createdBy, "createdBy");
  const createdGradle = gradleObject(createdBy?.gradle, "createdBy.gradle");
  // Count each expanded collection before any report record is built.
  admit(
    "variants",
    MAVEN_GRADLE_METADATA_VARIANTS,
    gradleArray(variantsValue, "variants").length,
  );
  const variants = gradleObjects(variantsValue, "variants");
  const rowLists = variants.flatMap((variant) => [
    gradleArray(variant.dependencies, "dependencies"),
    gradleArray(variant.dependencyConstraints, "dependencyConstraints"),
  ]);
  admit(
    "dependency_rows",
    MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS,
    rowLists.reduce((count, rows) => count + rows.length, 0),
  );
  let exclusions = 0;
  for (const rows of rowLists)
    for (const row of rows)
      if (isRecord(row))
        exclusions += gradleArray(row.excludes, "excludes").length;
  admit("exclusions", MAVEN_GRADLE_METADATA_EXCLUSIONS, exclusions);
  const dependencies: MavenGradleDependency<"variant-dependencies">[] = [];
  const dependency_management: MavenGradleDependency<"variant-constraints">[] =
    [];
  const gradleVariants: NonNullable<MavenGradleMetadata["gradle"]>["variants"] =
    [];
  let nextIndex = 0;
  const repeatedVariantNames = new Budget(
    MAVEN_GRADLE_METADATA_REPEATED_VARIANT_NAME_CHARS,
  );
  const variantNameIndices = new Map<string, number>();
  for (const [index, variant] of variants.entries()) {
    const declaredName = variant.name;
    if (declaredName !== undefined && typeof declaredName !== "string")
      throw malformedInput(
        MAVEN_GRADLE_METADATA_FORMAT,
        `Gradle module metadata variant.name at index ${String(index)} is not a string.`,
      );
    const name =
      declaredName === undefined || declaredName === "" ? null : declaredName;
    if (name !== null) {
      const previous = variantNameIndices.get(name);
      if (previous !== undefined)
        throw malformedInput(
          MAVEN_GRADLE_METADATA_FORMAT,
          `Gradle module metadata declares a duplicate variant name at indices ${String(previous)} and ${String(index)}.`,
        );
      variantNameIndices.set(name, index);
    }
    const attributes = gradleObject(variant.attributes, "variant.attributes");
    const category = gradleText(attributes?.["org.gradle.category"]);
    const usage = gradleText(attributes?.["org.gradle.usage"]);
    const platform =
      category === "platform" || category === "enforced-platform";
    const available = gradleObject(variant["available-at"], "available-at");
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
    const repeated =
      (name?.length ?? 0) * (variantDependencies.length + constraints.length);
    repeatedVariantNames.charge(repeated, () =>
      metadataReportLimit(
        "repeated_variant_name_chars",
        repeatedVariantNames.maximum,
        repeatedVariantNames.used + repeated,
      ),
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
              group_id: gradleText(available.group),
              artifact_id: gradleText(available.module),
              version: gradleText(available.version),
              ...redactRecordedTransportUrl(gradleText(available.url)),
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
        createdGradle === null ? null : gradleText(createdGradle.version),
      variants: gradleVariants,
    },
    unresolved: unresolved.finish(),
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
    source = decodeStrictUtf8(bytes, "strip-signature");
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
