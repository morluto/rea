import type { AnalysisError } from "../analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../analysisErrorCore.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { err, ok, type Result } from "../result.js";
import {
  CARGO_MANIFEST_FACT_BYTES,
  CARGO_MANIFEST_OPERATION,
  type CargoDependency,
  type CargoManifest,
} from "./cargoManifest.js";

type CargoManifestArtifact = CargoManifest["artifact"];

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const pointerPart = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
const identity = (prefix: string, facts: unknown) =>
  `${prefix}_${digestCanonicalValue(facts)}`;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

const DEPENDENCY_TABLES = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
] as const;

/** Every dependency table a single manifest can declare, with the target it is scoped to. */
interface DependencyTable {
  readonly pointer: string;
  readonly target: string | null;
  readonly declaredBy: "package" | "workspace";
  readonly entries: Record<string, unknown>;
}

const dependencyTables = (document: Record<string, unknown>) => {
  const tables: DependencyTable[] = [];
  for (const name of DEPENDENCY_TABLES) {
    const entries = record(document[name]);
    if (entries !== undefined)
      tables.push({
        pointer: `/${name}`,
        target: null,
        declaredBy: "package",
        entries,
      });
  }
  const target = record(document.target);
  if (target !== undefined)
    for (const [condition, value] of Object.entries(target)) {
      const container = record(value);
      if (container === undefined) continue;
      for (const name of DEPENDENCY_TABLES) {
        const entries = record(container[name]);
        if (entries !== undefined)
          tables.push({
            pointer: `/target/${pointerPart(condition)}/${name}`,
            target: condition,
            declaredBy: "package",
            entries,
          });
      }
    }
  const workspace = record(document.workspace);
  const inherited = record(workspace?.dependencies);
  if (inherited !== undefined)
    tables.push({
      pointer: "/workspace/dependencies",
      target: null,
      declaredBy: "workspace",
      entries: inherited,
    });
  return tables;
};

/** Classify one declaration by the source keys Cargo itself understands. */
const classify = (
  declaration: Record<string, unknown>,
):
  | {
      readonly source: CargoDependency["source"];
      readonly sourceDetail: string | null;
      readonly requirement: string | null;
    }
  | undefined => {
  if (declaration.workspace === true)
    return { source: "workspace", sourceDetail: null, requirement: null };
  const path = declaration.path;
  if (typeof path === "string")
    return { source: "path", sourceDetail: path, requirement: null };
  const git = declaration.git;
  if (typeof git === "string") {
    const revision = ["rev", "tag", "branch"].flatMap((key) => {
      const value = declaration[key];
      return typeof value === "string" ? [`${key}=${value}`] : [];
    });
    return {
      source: "git",
      sourceDetail: [git, ...revision].join(" "),
      requirement:
        typeof declaration.version === "string" ? declaration.version : null,
    };
  }
  if (typeof declaration.version === "string")
    return {
      source: "registry",
      sourceDetail:
        typeof declaration.registry === "string" ? declaration.registry : null,
      requirement: declaration.version,
    };
  return undefined;
};

/** Own declaration inventory and account for retained facts before allocation. */
class CargoInventory {
  readonly packages: CargoManifest["packages"] = [];
  readonly dependencies: CargoDependency[] = [];
  readonly features: CargoManifest["features"] = [];
  readonly diagnostics: CargoManifest["diagnostics"] = [];
  #retainedBytes = 0;

  constructor(readonly artifact: CargoManifestArtifact) {}

  reserve(bytes: number): Result<void, AnalysisError> {
    this.#retainedBytes += bytes;
    return this.#retainedBytes <= CARGO_MANIFEST_FACT_BYTES
      ? ok(undefined)
      : err(
          new AnalysisResourceConstraintError(
            CARGO_MANIFEST_OPERATION,
            "memory",
            "Cargo manifest declarations exceed the retained-facts representation allowance.",
            { representation_bytes: CARGO_MANIFEST_FACT_BYTES },
            {
              retryable: false,
              remediationAction:
                "Select a smaller complete manifest; reply paging does not increase the parser's retained-facts allowance.",
            },
          ),
        );
  }

  diagnostic(
    code: CargoManifest["diagnostics"][number]["code"],
    pointer: string,
    message: string,
  ): Result<void, AnalysisError> {
    const admitted = this.reserve(1024 + pointer.length * 12);
    if (!admitted.ok) return admitted;
    this.diagnostics.push({
      diagnostic_id: identity("cargo_diagnostic", [
        this.artifact.sha256,
        pointer,
        code,
      ]),
      source_pointer: pointer,
      code,
      message,
    });
    return ok(undefined);
  }

  dependency(
    key: string,
    value: unknown,
    table: DependencyTable,
    pointer: string,
  ): Result<void, AnalysisError> {
    const admitted = this.reserve(2048 + pointer.length * 24);
    if (!admitted.ok) return admitted;
    const declaredBy = table.declaredBy;
    const declaration =
      typeof value === "string" ? { version: value } : record(value);
    if (declaration === undefined) {
      this.dependencies.push({
        dependency_id: identity("cargo_dependency", [
          this.artifact.sha256,
          pointer,
          key,
        ]),
        dependency_key: identity("cargo_dependency_key", [key, table.pointer]),
        name: key,
        alias: null,
        requirement: null,
        source: "unknown",
        source_detail: null,
        declared_by: declaredBy,
        optional: false,
        default_features: true,
        features: [],
        target: table.target,
        source_pointer: pointer,
      });
      return this.diagnostic(
        "invalid-dependency-declaration",
        pointer,
        `Dependency "${key}" is neither a version requirement string nor a table.`,
      );
    }
    const classified = classify(declaration);
    if (classified === undefined)
      return this.diagnostic(
        "invalid-dependency-declaration",
        pointer,
        `Dependency "${key}" declares no version, path, git or workspace source.`,
      );
    const packageName = declaration.package;
    this.dependencies.push({
      dependency_id: identity("cargo_dependency", [
        this.artifact.sha256,
        pointer,
        key,
      ]),
      dependency_key: identity("cargo_dependency_key", [key, table.pointer]),
      name: typeof packageName === "string" ? packageName : key,
      alias: typeof packageName === "string" ? key : null,
      requirement: classified.requirement,
      source: classified.source,
      source_detail: classified.sourceDetail,
      declared_by: declaredBy,
      optional: declaration.optional === true,
      default_features: declaration["default-features"] !== false,
      features: stringArray(declaration.features) ?? [],
      target: table.target,
      source_pointer: pointer,
    });
    return ok(undefined);
  }
}

const rootFailure = (message: string) =>
  err(
    new AnalysisInputError(CARGO_MANIFEST_OPERATION, undefined, [
      { path: ["path"], reason: "invalid_format", message },
    ]),
  );

/** Inventory declarations in one already-parsed manifest; nothing is resolved or executed. */
export const parseCargoManifest = (
  document: unknown,
  artifact: CargoManifestArtifact,
): Result<CargoManifest, AnalysisError> => {
  const table = record(document);
  if (table === undefined)
    return rootFailure("Expected a TOML document at the root of the manifest.");

  const inventory = new CargoInventory(artifact);
  const workspace = record(table.workspace);
  const packageTable = record(table.package);

  if (packageTable === undefined && workspace === undefined)
    return rootFailure(
      "Manifest declares neither a [package] nor a [workspace] table.",
    );

  const members = stringArray(workspace?.members);
  const excludes = stringArray(workspace?.excludes);
  if (workspace !== undefined && members === undefined) {
    const recorded = inventory.diagnostic(
      "invalid-manifest-form",
      "/workspace/members",
      "workspace.members is absent or is not an array of strings.",
    );
    if (!recorded.ok) return recorded;
  }
  if (
    workspace !== undefined &&
    workspace.dependencies !== undefined &&
    record(workspace.dependencies) === undefined
  ) {
    const recorded = inventory.diagnostic(
      "invalid-dependency-table",
      "/workspace/dependencies",
      "workspace.dependencies is not a table.",
    );
    if (!recorded.ok) return recorded;
  }

  if (packageTable !== undefined) {
    const name = packageTable.name;
    if (typeof name !== "string")
      return rootFailure("[package].name is absent or is not a string.");
    const admitted = inventory.reserve(2048 + name.length * 24);
    if (!admitted.ok) return admitted;
    inventory.packages.push({
      package_id: identity("cargo_package", [artifact.sha256, name]),
      name,
      version:
        typeof packageTable.version === "string" ? packageTable.version : null,
      edition:
        typeof packageTable.edition === "string" ? packageTable.edition : null,
      rust_version:
        typeof packageTable["rust-version"] === "string"
          ? packageTable["rust-version"]
          : null,
      source_pointer: "/package",
      is_workspace_root: workspace !== undefined,
    });
  }

  for (const dependencyTable of dependencyTables(table)) {
    for (const [key, value] of Object.entries(dependencyTable.entries)) {
      const pointer = `${dependencyTable.pointer}/${pointerPart(key)}`;
      const declaration = typeof value === "string" ? undefined : record(value);
      if (
        dependencyTable.declaredBy === "package" &&
        declaration?.workspace === true &&
        workspace === undefined
      ) {
        const recorded = inventory.diagnostic(
          "workspace-inheritance-without-workspace",
          pointer,
          `Dependency "${key}" inherits from a workspace this manifest does not declare.`,
        );
        if (!recorded.ok) return recorded;
      }
      const added = inventory.dependency(key, value, dependencyTable, pointer);
      if (!added.ok) return added;
    }
  }

  const features = record(table.features);
  if (features !== undefined)
    for (const [name, value] of Object.entries(features)) {
      const enables = stringArray(value);
      if (enables === undefined) {
        const recorded = inventory.diagnostic(
          "invalid-feature-table",
          `/features/${pointerPart(name)}`,
          `Feature "${name}" is not an array of strings.`,
        );
        if (!recorded.ok) return recorded;
        continue;
      }
      const admitted = inventory.reserve(1024 + name.length * 12);
      if (!admitted.ok) return admitted;
      inventory.features.push({
        name,
        enables,
        source_pointer: `/features/${pointerPart(name)}`,
      });
    }

  const count = (predicate: (dependency: CargoDependency) => boolean) =>
    inventory.dependencies.filter(predicate).length;

  return ok({
    manifest_id: `cargo_manifest_${artifact.sha256}`,
    format: "cargo-toml",
    artifact,
    workspace: {
      members: members ?? [],
      excludes: excludes ?? [],
      resolver:
        typeof workspace?.resolver === "string"
          ? workspace.resolver
          : typeof packageTable?.resolver === "string"
            ? packageTable.resolver
            : null,
    },
    packages: inventory.packages,
    dependencies: inventory.dependencies,
    features: inventory.features,
    diagnostics: inventory.diagnostics,
    summary: {
      packages: inventory.packages.length,
      dependencies: inventory.dependencies.length,
      workspace_dependencies: count(
        (dependency) => dependency.declared_by === "workspace",
      ),
      inherited_dependencies: count(
        (dependency) => dependency.source === "workspace",
      ),
      git_dependencies: count((dependency) => dependency.source === "git"),
      path_dependencies: count((dependency) => dependency.source === "path"),
      target_dependencies: count((dependency) => dependency.target !== null),
      diagnostics: inventory.diagnostics.length,
    },
    source_coverage: {
      scope: "single-manifest-declarations",
      status:
        inventory.diagnostics.length === 0
          ? "complete-within-scope"
          : "partial",
      lockfile: "not-read",
      resolution: "not-attempted",
      workspace_member_manifests: "not-read",
      build_scripts: "not-executed",
      duplicate_toml_tables: "rejected",
    },
    limitations: [
      "Only the supplied Cargo.toml is read; workspace member manifests and Cargo.lock are not.",
      "Declared requirements are inventoried as written and never resolved against a registry.",
      "Target conditions are recorded as declared and are not evaluated for this host.",
      "Dependency aliases keep the manifest key and the package name apart; neither is verified.",
    ],
  });
};
