import type { Document, Element, Node } from "@xmldom/xmldom";
import { digestCanonicalValue } from "../canonicalDigest.js";
import {
  MAVEN_POM_LIMITATIONS,
  type MavenCoordinate,
  type MavenDependency,
  type MavenPom,
  type MavenPomDiagnostic,
  type MavenVersionOrigin,
} from "./mavenPom.js";

type DiagnosticCode = MavenPomDiagnostic["code"];
type Section = "dependencies" | "dependency_management";

const identity = (prefix: string, facts: unknown) =>
  `${prefix}_${digestCanonicalValue(facts)}`;

const childElements = (node: Element): readonly Element[] => {
  const elements: Element[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child !== null && child.nodeType === 1)
      elements.push(child as unknown as Element);
  }
  return elements;
};

/** Direct child by local name; the POM namespace is accepted and never required. */
const child = (node: Element, name: string): Element | undefined =>
  childElements(node).find((candidate) => candidate.localName === name);

const children = (node: Element, name: string): readonly Element[] =>
  childElements(node).filter((candidate) => candidate.localName === name);

const textOf = (element: Element): string => {
  const collected: string[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index);
    if (node !== null && (node.nodeType === 3 || node.nodeType === 4))
      collected.push(node.nodeValue ?? "");
  }
  return collected.join("").trim();
};

const text = (node: Element, name: string): string | null => {
  const element = child(node, name);
  return element === undefined ? null : textOf(element);
};

const lineOf = (node: Node | null): number | null => {
  if (node === null) return null;
  const line = (node as Node & { readonly lineNumber?: unknown }).lineNumber;
  return typeof line === "number" && Number.isSafeInteger(line) && line > 0
    ? line
    : null;
};

/** Structural pointer from the project root, using sibling position per local name. */
const pointer = (root: Element, node: Element): string => {
  const segments: string[] = [];
  let current: Element = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (parent === null || parent.nodeType !== 1) break;
    const element = parent as Element;
    const position = childElements(element)
      .filter((candidate) => candidate.localName === current.localName)
      .indexOf(current);
    segments.unshift(`${current.localName}[${position < 0 ? 0 : position}]`);
    if (element === root) break;
    current = element;
  }
  return `/${segments.join("/")}`;
};

const PROPERTY_REFERENCE = /\$\{([^{}]+)\}/u;

const referenceNames = (value: string | null): readonly string[] =>
  value === null
    ? []
    : [...value.matchAll(/\$\{([^{}]+)\}/gu)].map((match) => match[1] ?? "");

/**
 * Resolve one `${...}` reference against this POM's own properties only.
 * Maven also resolves project and parent fields, but those come from unread
 * documents, so they stay unresolved rather than being inferred.
 */
const resolveReference = (
  value: string,
  properties: ReadonlyMap<string, string>,
): string | null => {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    const match = PROPERTY_REFERENCE.exec(current);
    if (match === null) return current;
    const replacement =
      match[1] === undefined ? undefined : properties.get(match[1]);
    if (replacement === undefined) return null;
    current = current.replace(match[0], replacement);
  }
  return PROPERTY_REFERENCE.test(current) ? null : current;
};

const coordinate = (element: Element | undefined): MavenCoordinate => ({
  group_id: element === undefined ? null : text(element, "groupId"),
  artifact_id: element === undefined ? null : text(element, "artifactId"),
  version: element === undefined ? null : text(element, "version"),
  packaging: element === undefined ? null : text(element, "packaging"),
});

interface Collector {
  readonly diagnostics: MavenPomDiagnostic[];
  readonly properties: Map<string, string>;
  readonly propertyPointers: Map<string, string>;
}

const report = (
  collector: Collector,
  code: DiagnosticCode,
  message: string,
  sourcePointer: string,
  line: number | null,
): void => {
  collector.diagnostics.push({
    diagnostic_id: identity("maven_diagnostic", {
      code,
      source_pointer: sourcePointer,
      message,
    }),
    code,
    message,
    source_pointer: sourcePointer,
    line,
  });
};

const versionOrigin = (
  version: string | null,
  managed: ReadonlyMap<string, string>,
  key: string,
): MavenVersionOrigin => {
  if (version === null)
    return managed.has(key)
      ? { kind: "managed", managed_by: "dependencyManagement" }
      : { kind: "unresolved" };
  return PROPERTY_REFERENCE.test(version)
    ? { kind: "property" }
    : { kind: "declared" };
};

const parseDependency = (
  element: Element,
  root: Element,
  section: Section,
  profile: string | null,
  managed: ReadonlyMap<string, string>,
  collector: Collector,
): MavenDependency | undefined => {
  const groupId = text(element, "groupId");
  const artifactId = text(element, "artifactId");
  const sourcePointer = pointer(root, element);
  const line = lineOf(element);
  if (groupId === null || artifactId === null) {
    report(
      collector,
      "missing-required-field",
      `Dependency omits ${groupId === null ? "groupId" : "artifactId"}; it is retained as a diagnostic, not a declaration.`,
      sourcePointer,
      line,
    );
    return undefined;
  }
  const version = text(element, "version");
  const scope = text(element, "scope");
  const classifier = text(element, "classifier");
  const exclusions = children(element, "exclusions").flatMap((container) =>
    children(container, "exclusion").flatMap((exclusion) => {
      const exclusionGroup = text(exclusion, "groupId");
      const exclusionArtifact = text(exclusion, "artifactId");
      if (exclusionGroup === null && exclusionArtifact === null) {
        report(
          collector,
          "invalid-exclusion",
          "Exclusion declares no groupId or artifactId, so it matches nothing.",
          pointer(root, exclusion),
          lineOf(exclusion),
        );
        return [];
      }
      return [{ group_id: exclusionGroup, artifact_id: exclusionArtifact }];
    }),
  );
  return {
    dependency_id: identity("maven_dependency", {
      group_id: groupId,
      artifact_id: artifactId,
      version,
      section,
      profile,
      scope,
      classifier,
    }),
    dependency_key: identity("maven_dependency_key", {
      group_id: groupId,
      artifact_id: artifactId,
    }),
    group_id: groupId,
    artifact_id: artifactId,
    version,
    version_origin: versionOrigin(version, managed, `${groupId}:${artifactId}`),
    declared_by: section,
    scope,
    optional:
      text(element, "optional") === null
        ? null
        : text(element, "optional") === "true",
    type: text(element, "type"),
    classifier,
    system_path: text(element, "systemPath"),
    exclusions,
    profile,
    source_pointer: sourcePointer,
    line,
  };
};

const sectionDependencies = (
  container: Element | undefined,
  root: Element,
  section: Section,
  profile: string | null,
  managed: ReadonlyMap<string, string>,
  collector: Collector,
): MavenDependency[] =>
  container === undefined
    ? []
    : children(container, "dependency").flatMap((element) => {
        const dependency = parseDependency(
          element,
          root,
          section,
          profile,
          managed,
          collector,
        );
        return dependency === undefined ? [] : [dependency];
      });

const collectProperties = (
  project: Element,
  collector: Collector,
): MavenPom["properties"] => {
  const container = child(project, "properties");
  if (container === undefined) return [];
  return childElements(container).flatMap((property) => {
    const name = property.localName;
    if (name === null) return [];
    if (collector.properties.has(name))
      report(
        collector,
        "duplicate-declaration",
        `Property ${name} is declared more than once; the last declaration is retained.`,
        pointer(project, property),
        lineOf(property),
      );
    collector.properties.set(name, textOf(property));
    collector.propertyPointers.set(name, pointer(project, property));
    return [
      {
        name,
        value: textOf(property),
        source_pointer: pointer(project, property),
      },
    ];
  });
};

/** Bounded, offline inventory of declarations in one Maven POM document. */
export const parseMavenPom = (
  document: Document,
  artifact: MavenPom["artifact"],
): MavenPom => {
  const root = document.documentElement;
  if (root === null)
    throw new TypeError("Maven POM document has no root element");
  const collector: Collector = {
    diagnostics: [],
    properties: new Map(),
    propertyPointers: new Map(),
  };

  const properties = collectProperties(root, collector);
  const modelVersion = text(root, "modelVersion");

  const management = child(root, "dependencyManagement");
  const managed = new Map<string, string>();
  if (management !== undefined)
    for (const dependency of children(
      child(management, "dependencies") ?? management,
      "dependency",
    )) {
      const groupId = text(dependency, "groupId");
      const artifactId = text(dependency, "artifactId");
      const version = text(dependency, "version");
      if (groupId !== null && artifactId !== null && version !== null)
        managed.set(`${groupId}:${artifactId}`, version);
    }

  const dependencyManagement = sectionDependencies(
    management === undefined ? undefined : child(management, "dependencies"),
    root,
    "dependency_management",
    null,
    managed,
    collector,
  );
  const declaredDependencies = sectionDependencies(
    child(root, "dependencies"),
    root,
    "dependencies",
    null,
    managed,
    collector,
  );

  const profiles: MavenPom["profiles"] = [];
  const profileDependencies: MavenDependency[] = [];
  for (const profile of children(root, "profiles").flatMap((container) =>
    children(container, "profile"),
  )) {
    const id = text(profile, "id");
    const activation = child(profile, "activation");
    profiles.push({
      id,
      active_by_default:
        activation === undefined
          ? null
          : text(activation, "activeByDefault") === "true",
      source_pointer: pointer(root, profile),
    });
    profileDependencies.push(
      ...sectionDependencies(
        child(profile, "dependencies"),
        root,
        "dependencies",
        id,
        managed,
        collector,
      ),
    );
  }

  const repositories = [
    ...children(child(root, "repositories") ?? root, "repository"),
    ...children(child(root, "pluginRepositories") ?? root, "repository"),
  ].map((repository) => ({
    id: text(repository, "id"),
    url: text(repository, "url"),
    layout: text(repository, "layout"),
  }));

  const dependencies = [...declaredDependencies, ...profileDependencies];
  const allDependencies = [...dependencies, ...dependencyManagement];

  const seen = new Set<string>();
  for (const dependency of allDependencies) {
    if (seen.has(dependency.dependency_id))
      report(
        collector,
        "duplicate-declaration",
        `${dependency.group_id}:${dependency.artifact_id} is declared more than once with the same version, scope and classifier; both declarations are retained.`,
        dependency.source_pointer,
        dependency.line,
      );
    else seen.add(dependency.dependency_id);
  }

  const referenceNamesSeen = new Set<string>();
  for (const value of [
    ...allDependencies.flatMap((dependency) => [
      dependency.group_id,
      dependency.artifact_id,
      dependency.version,
      dependency.scope,
      dependency.classifier,
    ]),
    text(root, "groupId"),
    text(root, "artifactId"),
    text(root, "version"),
  ])
    for (const name of referenceNames(value)) referenceNamesSeen.add(name);

  for (const name of referenceNamesSeen)
    if (!collector.properties.has(name))
      report(
        collector,
        "unresolved-property",
        `\${${name}} is referenced but not declared in this POM; it is retained as a reference, not resolved.`,
        collector.propertyPointers.get(name) ?? "/project",
        null,
      );

  const project = coordinate(root);
  const parentElement = child(root, "parent");
  const parent =
    parentElement === undefined
      ? null
      : {
          ...coordinate(parentElement),
          relative_path: text(parentElement, "relativePath"),
        };

  return {
    pom_id: identity("maven_pom", {
      sha256: artifact.sha256,
      group_id: project.group_id,
      artifact_id: project.artifact_id,
      version: project.version,
    }),
    format: "maven-pom",
    artifact,
    model_version: modelVersion,
    project,
    parent,
    properties,
    dependencies,
    dependency_management: dependencyManagement,
    repositories,
    profiles,
    property_references: [...referenceNamesSeen].map((name) => {
      const declared = collector.properties.get(name) ?? null;
      return {
        name,
        declared,
        resolved:
          declared === null
            ? null
            : resolveReference(declared, collector.properties),
        source_pointer: collector.propertyPointers.get(name) ?? "/project",
      };
    }),
    diagnostics: collector.diagnostics,
    summary: {
      dependencies: dependencies.length,
      dependency_management: dependencyManagement.length,
      managed_dependencies: allDependencies.filter(
        (dependency) =>
          dependency.version_origin.kind === "managed" ||
          (dependency.version !== null &&
            managed.has(`${dependency.group_id}:${dependency.artifact_id}`)),
      ).length,
      optional_dependencies: allDependencies.filter(
        (dependency) => dependency.optional === true,
      ).length,
      excluded_dependencies: allDependencies.filter(
        (dependency) => dependency.exclusions.length > 0,
      ).length,
      profile_dependencies: profileDependencies.length,
      repositories: repositories.length,
      properties: properties.length,
      unresolved_versions: dependencies.filter(
        (dependency) =>
          dependency.version_origin.kind === "unresolved" ||
          dependency.version_origin.kind === "property",
      ).length,
      diagnostics: collector.diagnostics.length,
    },
    source_coverage: {
      scope: "single-pom-declarations",
      status:
        collector.diagnostics.length === 0
          ? "complete-within-scope"
          : "partial",
      parent_pom: "not-read",
      bom_imports: "not-resolved",
      transitive_dependencies: "not-resolved",
      repositories: "not-contacted",
      build_execution: "not-attempted",
      profile_activation: "declarations-only",
      duplicate_declarations: "reported",
    },
    limitations: [...MAVEN_POM_LIMITATIONS],
  };
};
