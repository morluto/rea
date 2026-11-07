import type { Document, Element, Node } from "@xmldom/xmldom";
import { digestCanonicalValue } from "../canonicalDigest.js";
import {
  MAVEN_POM_LIMITATIONS,
  MAVEN_POM_MAX_RETAINED_BYTES,
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
const pointer = (root: Element, node: Element, collector: Collector): string => {
  const segments: string[] = [];
  let current: Element = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (parent === null || parent.nodeType !== 1) break;
    const element = parent as Element;
    if (!collector.indexedParents.has(element)) {
      const counts = new Map<string | null, number>();
      for (let index = 0; index < element.childNodes.length; index += 1) {
        const sibling = element.childNodes.item(index);
        if (sibling === null || sibling.nodeType !== 1) continue;
        const child = sibling as Element;
        const position = counts.get(child.localName) ?? 0;
        collector.positions.set(child, position);
        counts.set(child.localName, position + 1);
      }
      collector.indexedParents.add(element);
    }
    const position = collector.positions.get(current) ?? 0;
    segments.unshift(`${current.localName}[${position}]`);
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

/** Bounded substitutions per resolved value; a POM cannot spend unbounded work here. */
const MAX_PROPERTY_SUBSTITUTIONS = 64;

type PropertyResolution =
  | { readonly kind: "resolved"; readonly value: string }
  | { readonly kind: "unresolved" }
  | { readonly kind: "cycle" }
  | { readonly kind: "work-limit" };

/**
 * Resolve one `${...}` reference against this POM's own properties only.
 * Maven also resolves project and parent fields, but those come from unread
 * documents, so they stay unresolved rather than being inferred. A real cycle
 * and the substitution allowance are reported separately so a valid value that
 * merely needs many substitutions is never called undeclared.
 */
const resolveReference = (
  value: string,
  properties: ReadonlyMap<string, string>,
): PropertyResolution => {
  let current = value;
  const visited = new Set<string>([value]);
  for (let substitutions = 0; ; substitutions += 1) {
    const match = PROPERTY_REFERENCE.exec(current);
    if (match === null) return { kind: "resolved", value: current };
    const replacement =
      match[1] === undefined ? undefined : properties.get(match[1]);
    if (replacement === undefined) return { kind: "unresolved" };
    if (substitutions >= MAX_PROPERTY_SUBSTITUTIONS)
      return { kind: "work-limit" };
    const next = current.replace(match[0], () => replacement);
    if (visited.has(next)) return { kind: "cycle" };
    visited.add(next);
    current = next;
  }
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
  readonly indexedParents: WeakSet<Element>;
  readonly positions: WeakMap<Element, number>;
  /** Accounted UTF-8 size of every retained fact; bounds representation growth. */
  retainedBytes: number;
}

/** Raised when declarations expand past the advertised retained-facts allowance. */
export class MavenPomRetainedFactsLimitError extends Error {
  constructor(
    readonly retainedBytes: number,
    readonly maxRetainedBytes: number,
  ) {
    super(
      `Retained POM declarations need at least ${retainedBytes} bytes, above the ${maxRetainedBytes}-byte allowance.`,
    );
    this.name = "MavenPomRetainedFactsLimitError";
  }
}

/** Account one retained fact's serialized size before it is kept. */
const account = (collector: Collector, facts: unknown): void => {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(facts) ?? "", "utf8");
  } catch {
    bytes = MAVEN_POM_MAX_RETAINED_BYTES + 1;
  }
  collector.retainedBytes += bytes;
  if (collector.retainedBytes > MAVEN_POM_MAX_RETAINED_BYTES)
    throw new MavenPomRetainedFactsLimitError(
      collector.retainedBytes,
      MAVEN_POM_MAX_RETAINED_BYTES,
    );
};

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

/**
 * Maven matches a managed dependency on groupId, artifactId, type and
 * classifier; omitting the last two means the defaults, not "any value".
 */
const DEFAULT_DEPENDENCY_TYPE = "jar";

const managementKey = (
  groupId: string | null,
  artifactId: string | null,
  type: string | null,
  classifier: string | null,
): string | null => {
  if (groupId === null || artifactId === null) return null;
  return [
    groupId,
    artifactId,
    type ?? DEFAULT_DEPENDENCY_TYPE,
    classifier ?? "",
  ]
    .map((part) => part.replaceAll("\\", "\\\\").replaceAll(":", "\\:"))
    .join(":");
};

/** Declared boolean text; unresolvable and non-Maven values stay unknown. */
const declaredBoolean = (element: Element | undefined): boolean | null => {
  if (element === undefined) return null;
  const value = textOf(element);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};

const versionOrigin = (
  version: string | null,
  managed: ReadonlyMap<string, string>,
  key: string | null,
): MavenVersionOrigin => {
  if (version === null)
    return key !== null && managed.has(key)
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
  const sourcePointer = pointer(root, element, collector);
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
  const type = text(element, "type");
  const exclusions = children(element, "exclusions").flatMap((container) =>
    children(container, "exclusion").flatMap((exclusion) => {
      const exclusionGroup = text(exclusion, "groupId");
      const exclusionArtifact = text(exclusion, "artifactId");
      if (exclusionGroup === null && exclusionArtifact === null) {
        report(
          collector,
          "invalid-exclusion",
          "Exclusion declares no groupId or artifactId, so it matches nothing.",
          pointer(root, exclusion, collector),
          lineOf(exclusion),
        );
        return [];
      }
      return [{ group_id: exclusionGroup, artifact_id: exclusionArtifact }];
    }),
  );
  const dependency: MavenDependency = {
    dependency_id: identity("maven_dependency", {
      group_id: groupId,
      artifact_id: artifactId,
      version,
      section,
      profile,
      scope,
      type,
      classifier,
    }),
    dependency_key: identity("maven_dependency_key", {
      group_id: groupId,
      artifact_id: artifactId,
      type,
      classifier,
    }),
    group_id: groupId,
    artifact_id: artifactId,
    version,
    version_origin: versionOrigin(
      version,
      managed,
      managementKey(groupId, artifactId, type, classifier),
    ),
    declared_by: section,
    scope,
    optional: declaredBoolean(child(element, "optional")),
    type,
    classifier,
    system_path: text(element, "systemPath"),
    exclusions,
    profile,
    source_pointer: sourcePointer,
    line,
  };
  account(collector, dependency);
  return dependency;
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
    const sourcePointer = pointer(project, property, collector);
    if (collector.properties.has(name))
      report(
        collector,
        "duplicate-declaration",
        `Property ${name} is declared more than once; the last declaration is retained.`,
        sourcePointer,
        lineOf(property),
      );
    const value = textOf(property);
    collector.properties.set(name, value);
    collector.propertyPointers.set(name, sourcePointer);
    const fact = { name, value, source_pointer: sourcePointer };
    account(collector, fact);
    return [fact];
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
    indexedParents: new WeakSet(),
    positions: new WeakMap(),
    retainedBytes: 0,
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
      const version = text(dependency, "version");
      const key = managementKey(
        text(dependency, "groupId"),
        text(dependency, "artifactId"),
        text(dependency, "type"),
        text(dependency, "classifier"),
      );
      if (key !== null && version !== null) managed.set(key, version);
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
  const profileManagement: MavenDependency[] = [];
  for (const profile of children(root, "profiles").flatMap((container) =>
    children(container, "profile"),
  )) {
    const id = text(profile, "id");
    const activation = child(profile, "activation");
    profiles.push({
      id,
      active_by_default: declaredBoolean(
        activation === undefined
          ? undefined
          : child(activation, "activeByDefault"),
      ),
      source_pointer: pointer(root, profile, collector),
    });
    // Declarations that live inside the profile stay attributed to it rather
    // than being reported as top-level facts.
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
    const profileManagementElement = child(profile, "dependencyManagement");
    if (profileManagementElement !== undefined)
      profileManagement.push(
        ...sectionDependencies(
          child(profileManagementElement, "dependencies"),
          root,
          "dependency_management",
          id,
          managed,
          collector,
        ),
      );
  }

  const repositories = [
    ...children(child(root, "repositories") ?? root, "repository"),
    ...children(child(root, "pluginRepositories") ?? root, "pluginRepository"),
  ].map((repository) => {
    const fact = {
      id: text(repository, "id"),
      url: text(repository, "url"),
      layout: text(repository, "layout"),
      source_pointer: pointer(root, repository, collector),
      line: lineOf(repository),
    };
    account(collector, fact);
    return fact;
  });

  const dependencies = [...declaredDependencies, ...profileDependencies];
  const allDependencies = [
    ...dependencies,
    ...dependencyManagement,
    ...profileManagement,
  ];
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
  const collectReferences = (values: readonly (string | null)[]): void => {
    for (const value of values)
      for (const name of referenceNames(value)) referenceNamesSeen.add(name);
  };
  for (const dependency of allDependencies)
    collectReferences([
      dependency.group_id,
      dependency.artifact_id,
      dependency.version,
      dependency.scope,
      dependency.type,
      dependency.classifier,
      dependency.system_path,
      ...dependency.exclusions.flatMap((exclusion) => [
        exclusion.group_id,
        exclusion.artifact_id,
      ]),
    ]);
  const parentElement = child(root, "parent");
  collectReferences([
    text(root, "groupId"),
    text(root, "artifactId"),
    text(root, "version"),
    ...(parentElement === undefined
      ? []
      : [
          text(parentElement, "groupId"),
          text(parentElement, "artifactId"),
          text(parentElement, "version"),
          text(parentElement, "relativePath"),
        ]),
    ...properties.map((property) => property.value),
    ...repositories.flatMap((repository) => [
      repository.id,
      repository.url,
      repository.layout,
    ]),
  ]);

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
    dependency_management: [...dependencyManagement, ...profileManagement],
    repositories,
    profiles,
    property_references: [...referenceNamesSeen].map((name) => {
      const declared = collector.properties.get(name) ?? null;
      const resolution =
        declared === null
          ? ({ kind: "unresolved" } as const)
          : resolveReference(declared, collector.properties);
      return {
        name,
        declared,
        resolution: resolution.kind,
        resolved: resolution.kind === "resolved" ? resolution.value : null,
        source_pointer: collector.propertyPointers.get(name) ?? "/project",
      };
    }),
    diagnostics: collector.diagnostics,
    summary: {
      dependencies: dependencies.length,
      dependency_management:
        dependencyManagement.length + profileManagement.length,
      managed_dependencies: allDependencies.filter(
        (dependency) =>
          dependency.version_origin.kind === "managed" ||
          (dependency.version !== null &&
            managed.has(
              managementKey(
                dependency.group_id,
                dependency.artifact_id,
                dependency.type,
                dependency.classifier,
              ) ?? "",
            )),
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
