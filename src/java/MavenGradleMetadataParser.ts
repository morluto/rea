import { MavenGradleUnresolvedCollector } from "./MavenGradleUnresolvedCollector.js";
import { Budget } from "../domain/budget.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { parseJsonWithDuplicatePolicy } from "../domain/jsonDuplicateMember.js";
import { isRecord } from "../kernel/isRecord.js";
import { malformedInput, unsupportedInput } from "../domain/parseFailure.js";
import type { Element, Node } from "@xmldom/xmldom";

import {
  isXmlElement,
  iterateXmlChildElements,
  opensLikeXml,
  parseTrueFalseText,
  parseXmlDocumentWithinNodeLimit,
  xmlChildElements,
  xmlChildrenNamed,
  xmlFirstChildNamed,
} from "../domain/xmlDocument.js";
import {
  mavenGradleReportLimits,
  type MavenGradleReportLimitField,
  type MavenGradleReportLimits,
  requestedVersionKind,
  type MavenGradleDependency,
  type MavenGradleMetadata,
} from "../domain/java/mavenGradleMetadata.js";
import { redactRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import {
  MAVEN_GRADLE_METADATA_FORMAT,
  metadataReportLimit,
} from "./MavenGradleMetadata.errors.js";

const BASE_LIMITATIONS = [
  "This workflow reads a Maven POM or Gradle module-metadata document without running Maven or Gradle, resolving a dependency tree, or contacting a repository.",
  "Requested versions, ranges, and property spellings are recorded as written; interpolation and parent/BOM inheritance are not performed.",
] as const;

const GRADLE_MODULE_METADATA_VERSION = "1.1";

const soleNamed = (element: Element, local: string): Element | undefined => {
  const [match, duplicate] = iterateXmlChildElements(
    element,
    local,
    element.namespaceURI ?? "",
  );
  if (duplicate !== undefined)
    throw malformedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      `Maven POM declares <${local}> more than once in one <${element.localName}>.`,
    );
  return match;
};

/** Maven names each POM model namespace by this prefix and its model version. */
const MAVEN_POM_NAMESPACE_PREFIX = "http://maven.apache.org/POM/";
/** Model versions released Maven reads: 4.0.0, and 4.1.0 for Maven 4 builds. */
const MAVEN_POM_MODEL_VERSIONS: readonly string[] = ["4.0.0", "4.1.0"];
const MAVEN_4_MODEL_VERSION = "4.1.0";

/**
 * A Maven POM root: `project` in a Maven POM namespace, or a namespace-free
 * `project` that declares `modelVersion` or `artifactId`. Ant and other
 * `project` vocabularies declare neither and are not POMs.
 */
const isMavenProjectRoot = (root: Node | null): root is Element => {
  if (!isXmlElement(root) || root.localName !== "project") return false;
  if (root.namespaceURI?.startsWith(MAVEN_POM_NAMESPACE_PREFIX) === true)
    return true;
  return (
    (root.namespaceURI === null || root.namespaceURI === "") &&
    (xmlFirstChildNamed(root, "modelVersion", "") !== undefined ||
      xmlFirstChildNamed(root, "artifactId", "") !== undefined)
  );
};

/** Refuse a report whose expanded collection would outgrow its fixed allowance. */
const admit = (
  allowance: MavenGradleReportLimitField,
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
    if (isXmlElement(child))
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

/**
 * The POM model version: `modelVersion` when declared, otherwise the version
 * named by the project namespace, as Maven 4 derives it. A namespaced POM must
 * name a supported model both ways; legacy namespace-free POMs keep any
 * declared `modelVersion`.
 */
const mavenModelVersion = (root: Element): string | null => {
  const namespace = root.namespaceURI ?? "";
  if (!namespace.startsWith(MAVEN_POM_NAMESPACE_PREFIX))
    return childText(root, "modelVersion");
  const namespaceVersion = namespace.slice(MAVEN_POM_NAMESPACE_PREFIX.length);
  if (!MAVEN_POM_MODEL_VERSIONS.includes(namespaceVersion))
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Maven POM uses a model namespace this reader does not support; it reads the 4.0.0 and 4.1.0 POM models.",
    );
  const declared = childText(root, "modelVersion");
  if (declared !== null && !MAVEN_POM_MODEL_VERSIONS.includes(declared))
    throw unsupportedInput(
      MAVEN_GRADLE_METADATA_FORMAT,
      "Maven POM declares a modelVersion this reader does not support; it reads the 4.0.0 and 4.1.0 POM models.",
    );
  return declared ?? namespaceVersion;
};

/** Keep Gradle JSON spelling for Evidence and exact comparisons. */
const gradleText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

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
  return container === undefined
    ? []
    : xmlChildrenNamed(container, "exclusion", container.namespaceURI ?? "");
};

const parseMavenDependency = <
  Origin extends "dependencies" | "dependencyManagement",
>(
  element: Element,
  origin: Origin,
  index: number,
  unresolved: MavenGradleUnresolvedCollector,
  maven4Model: boolean,
): MavenGradleDependency<Origin> => {
  const group_id = childText(element, "groupId");
  const artifact_id = childText(element, "artifactId");
  const version = childText(element, "version");
  const type = childText(element, "type");
  const scope = childText(element, "scope");
  // Maven 4 also imports a managed `bom` type, whatever its scope. Only a
  // 4.1.0 model POM is certain to be built by Maven 4 rather than Maven 3.
  const bom_import =
    origin === "dependencyManagement" &&
    ((type === "pom" && scope === "import") || (maven4Model && type === "bom"));
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
    optional: parseTrueFalseText(optional_spelling),
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
  limits: MavenGradleReportLimits,
): MavenGradleMetadata => {
  const limitations: string[] = [...BASE_LIMITATIONS];
  // Maven applies XML 1.0 end-of-line handling to property and coordinate text.
  const parsed = parseXmlDocumentWithinNodeLimit(xml, {
    lineEndings: "normalize",
    maximumNodes: limits.xml_nodes,
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
  const maven4Model = mavenModelVersion(root) === MAVEN_4_MODEL_VERSION;
  const unresolved = new MavenGradleUnresolvedCollector(
    limits.unresolved_records,
  );
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
      : xmlChildElements(propertiesElement).map((property) => {
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
      : xmlChildrenNamed(
          managedContainer,
          "dependency",
          managedContainer.namespaceURI ?? "",
        );
  const dependenciesContainer = soleNamed(root, "dependencies");
  const dependencyElements =
    dependenciesContainer === undefined
      ? []
      : xmlChildrenNamed(
          dependenciesContainer,
          "dependency",
          dependenciesContainer.namespaceURI ?? "",
        );
  admit(
    "dependency_rows",
    limits.dependency_rows,
    managedElements.length + dependencyElements.length,
  );
  admit(
    "exclusions",
    limits.exclusions,
    [...managedElements, ...dependencyElements].reduce(
      (count, element) => count + mavenExclusionElements(element).length,
      0,
    ),
  );
  const dependency_management = managedElements.map((element, index) =>
    parseMavenDependency(
      element,
      "dependencyManagement",
      index,
      unresolved,
      maven4Model,
    ),
  );
  const dependencies = dependencyElements.map((element, index) =>
    parseMavenDependency(
      element,
      "dependencies",
      index,
      unresolved,
      maven4Model,
    ),
  );
  if (parent !== null)
    limitations.push(
      "Parent coordinates are recorded as spelled; the parent POM was not read and inheritance was not applied.",
    );
  if (maven4Model)
    limitations.push(
      "Maven 4 can infer omitted parent coordinates and, in model version 4.1.0, omitted dependency and managed dependency group IDs and versions from the local project tree; that inference was not applied.",
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
  limits: MavenGradleReportLimits,
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
  const unresolved = new MavenGradleUnresolvedCollector(
    limits.unresolved_records,
  );
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
    limits.variants,
    gradleArray(variantsValue, "variants").length,
  );
  const variants = gradleObjects(variantsValue, "variants");
  const rowLists = variants.flatMap((variant) => [
    gradleArray(variant.dependencies, "dependencies"),
    gradleArray(variant.dependencyConstraints, "dependencyConstraints"),
  ]);
  admit(
    "dependency_rows",
    limits.dependency_rows,
    rowLists.reduce((count, rows) => count + rows.length, 0),
  );
  let exclusions = 0;
  for (const rows of rowLists)
    for (const row of rows)
      if (isRecord(row))
        exclusions += gradleArray(row.excludes, "excludes").length;
  admit("exclusions", limits.exclusions, exclusions);
  const dependencies: MavenGradleDependency<"variant-dependencies">[] = [];
  const dependency_management: MavenGradleDependency<"variant-constraints">[] =
    [];
  const gradleVariants: NonNullable<MavenGradleMetadata["gradle"]>["variants"] =
    [];
  let nextIndex = 0;
  const repeatedVariantNames = new Budget(limits.repeated_variant_name_chars);
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
  limits: MavenGradleReportLimits = mavenGradleReportLimits(),
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
    return parseGradle(source, artifact, limits);
  if (opensLikeXml(trimmed) || trimmed.startsWith("<"))
    return parsePom(source, artifact, limits);
  throw unsupportedInput(
    MAVEN_GRADLE_METADATA_FORMAT,
    "Selected file is not a Maven POM or Gradle module-metadata document.",
  );
};
