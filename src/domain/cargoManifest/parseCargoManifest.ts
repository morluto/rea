import type { AnalysisError } from "../analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../analysisErrorCore.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { parseRecordedTransportUrl } from "../recordedTransportUrl.js";
import { err, ok, type Result } from "../result.js";
import {
  CARGO_MANIFEST_FACT_BYTES,
  CARGO_MANIFEST_OPERATION,
  type CargoDependency,
  type CargoManifest,
} from "./cargoManifest.js";

type CargoManifestArtifact = CargoManifest["artifact"];
type DiagnosticCode = CargoManifest["diagnostics"][number]["code"];

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

/** Cargo's current and pre-2024 spellings of the same dependency tables. */
const DEPENDENCY_TABLES = [
  "dependencies",
  "dev-dependencies",
  "dev_dependencies",
  "build-dependencies",
  "build_dependencies",
] as const;

/** Every dependency table a single manifest can declare, with the target it is scoped to. */
interface DependencyTable {
  readonly pointer: string;
  readonly target: string | null;
  readonly declaredBy: "package" | "workspace";
  readonly entries: Record<string, unknown>;
}

/** Report a present but unusable field instead of letting it look absent. */
const tableFailure = (
  value: unknown,
): "absent" | "malformed" | Record<string, unknown> => {
  // An absent field is omission; a present non-table is an explicit unknown.
  if (value === undefined) return "absent";
  const entries = record(value);
  if (entries === undefined) return "malformed";
  return entries;
};

/** One retained string, charged at its expanded UTF-16 length before it is kept. */
const expandedBytes = (value: string): number => value.length * 2;

/**
 * Expanded size of a retained value. Strings are charged directly; arrays and
 * objects are charged for the strings they hold, so a container cannot carry
 * values past the allowance just because only its own shape was counted.
 */
const expandedBytesOf = (value: unknown, seen = new Set<object>()): number => {
  if (typeof value === "string") return expandedBytes(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value).length;
  if (typeof value !== "object" || value === null) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((item) => expandedBytesOf(item, seen))
    : Object.entries(value).flatMap(([key, item]) => [
        expandedBytes(key),
        expandedBytesOf(item, seen),
      ]);
  return entries.reduce((total, bytes) => total + bytes, 0);
};

/** Strip transport userinfo so recorded evidence never carries credentials. */
const credentialFree = (value: string): string => {
  const { credentials } = parseRecordedTransportUrl(value);
  if (credentials === "ambiguous") {
    const parsed = URL.parse(value);
    if (parsed === null) return value;
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  }
  return credentials === null
    ? value
    : `${value.slice(0, credentials.start)}${value.slice(credentials.end)}`;
};

/** Classify one declaration by the source keys Cargo itself understands. */
const classify = (
  declaration: Record<string, unknown>,
):
  | {
      readonly source: CargoDependency["source"];
      readonly sourceDetail: string | null;
      readonly requirement: string | null;
      readonly registry: string | null;
    }
  | undefined => {
  const version =
    typeof declaration.version === "string" ? declaration.version : null;
  const registry =
    typeof declaration.registry === "string"
      ? credentialFree(declaration.registry)
      : null;
  if (declaration.workspace === true)
    return {
      source: "workspace",
      sourceDetail: null,
      requirement: version,
      registry,
    };
  const path = declaration.path;
  if (typeof path === "string")
    // A filesystem path is not a URL: redaction would rewrite directory names
    // such as `//build@cache/helper` and send the reader elsewhere.
    return {
      source: "path",
      sourceDetail: path,
      requirement: version,
      registry,
    };
  const git = declaration.git;
  if (typeof git === "string") {
    const revision = ["rev", "tag", "branch"].flatMap((key) => {
      const value = declaration[key];
      return typeof value === "string" ? [`${key}=${value}`] : [];
    });
    return {
      source: "git",
      sourceDetail: [credentialFree(git), ...revision].join(" "),
      requirement: version,
      registry,
    };
  }
  if (version !== null)
    return {
      source: "registry",
      sourceDetail: registry,
      requirement: version,
      registry,
    };
  return undefined;
};

/**
 * An inherited declaration takes `default-features` from the workspace entry,
 * which this reader deliberately does not open. Reporting `true` there would
 * claim a setting the manifest does not state.
 */
const defaultFeatures = (
  declaration: Record<string, unknown>,
  source: CargoDependency["source"],
  legacyStatus: "supported" | "unsupported" | "unknown",
): boolean | null => {
  const modern = declaration["default-features"];
  if (modern !== undefined) return typeof modern === "boolean" ? modern : null;
  if (
    declaration.default_features !== undefined &&
    legacyStatus !== "supported"
  )
    return null;
  const declared = declaration.default_features;
  if (typeof declared === "boolean") return declared;
  if (declared !== undefined) return null;
  return source === "workspace" ? null : true;
};

/** Field-level problems that would otherwise be flattened into plausible facts. */
const declarationProblems = (
  declaration: Record<string, unknown>,
  legacyStatus: "supported" | "unsupported" | "unknown",
): readonly string[] => {
  const problems: string[] = [];
  if (
    declaration.optional !== undefined &&
    typeof declaration.optional !== "boolean"
  )
    problems.push("optional is not a boolean");
  if (
    declaration["default-features"] !== undefined &&
    typeof declaration["default-features"] !== "boolean"
  )
    problems.push("default-features is not a boolean");
  if (
    declaration.default_features !== undefined &&
    typeof declaration.default_features !== "boolean"
  )
    problems.push("default_features is not a boolean");
  if (
    declaration.default_features !== undefined &&
    legacyStatus === "unsupported"
  )
    problems.push("default_features is unsupported in edition 2024 or later");
  if (declaration.default_features !== undefined && legacyStatus === "unknown")
    problems.push(
      "default_features support is unknown because the package edition is inherited",
    );
  if (
    declaration.features !== undefined &&
    stringArray(declaration.features) === undefined
  )
    problems.push("features is not an array of strings");
  if (
    declaration.package !== undefined &&
    typeof declaration.package !== "string"
  )
    problems.push("package is not a string");
  if (
    declaration.registry !== undefined &&
    typeof declaration.registry !== "string"
  )
    problems.push("registry is not a string");
  for (const key of ["rev", "tag", "branch"]) {
    if (declaration[key] !== undefined && typeof declaration[key] !== "string")
      problems.push(`${key} is not a string`);
  }
  if (
    typeof declaration.path === "string" &&
    typeof declaration.git === "string"
  )
    problems.push("path and git are both declared");
  return problems;
};

/** Own declaration inventory and account for retained facts before allocation. */
class CargoInventory {
  readonly packages: CargoManifest["packages"] = [];
  readonly dependencies: CargoDependency[] = [];
  readonly features: CargoManifest["features"] = [];
  readonly diagnostics: CargoManifest["diagnostics"] = [];
  /**
   * A `[package]` edition that is present but is neither a string nor a
   * `workspace = true` inheritance. Edition-dependent interpretation must stay
   * unknown instead of falling back to the pre-2024 default.
   */
  packageEditionUnreadable = false;
  #retainedBytes = 0;

  constructor(readonly artifact: CargoManifestArtifact) {}

  /** Charge retained values by their expanded representation, not by their count. */
  retain(
    ...values: readonly (string | readonly string[])[]
  ): Result<void, AnalysisError> {
    return this.reserve(expandedBytesOf(values));
  }

  /**
   * Charge a value this inventory keeps from the source document without
   * rewriting it. The expanded size of a container is the expanded size of the
   * values inside it, which is what retention has to account for.
   */
  retainSource(...values: readonly unknown[]): Result<void, AnalysisError> {
    return this.reserve(expandedBytesOf(values));
  }

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
    code: DiagnosticCode,
    pointer: string,
    message: string,
  ): Result<void, AnalysisError> {
    const admitted = this.retain(message, pointer);
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
    const declaredBy = table.declaredBy;
    // Only the facts the report emits are charged. The declaration itself is
    // discarded after classification, so charging it as well would count the
    // same text twice and reject manifests whose report fits the allowance.
    const declaration =
      typeof value === "string" ? { version: value } : record(value);
    if (declaration === undefined) {
      const admitted = this.retain(key, pointer, table.target ?? "");
      if (!admitted.ok) return admitted;
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
        registry: null,
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
    if (classified === undefined) {
      // The diagnostic owns the only emitted text for this declaration.
      return this.diagnostic(
        "invalid-dependency-declaration",
        pointer,
        `Dependency "${key}" declares no version, path, git or workspace source.`,
      );
    }
    const packageName = declaration.package;
    const alias = typeof packageName === "string" ? key : null;
    const name = typeof packageName === "string" ? packageName : key;
    const features = stringArray(declaration.features) ?? [];
    const edition = this.packages[0]?.edition;
    const legacyStatus =
      declaredBy === "package" &&
      (edition === "inherited" || this.packageEditionUnreadable)
        ? "unknown"
        : declaredBy === "package" &&
            typeof edition === "string" &&
            /^\d{4}$/u.test(edition) &&
            Number(edition) >= 2024
          ? "unsupported"
          : "supported";
    const retained = this.retain(
      pointer,
      name,
      alias ?? "",
      table.target ?? "",
      classified.sourceDetail ?? "",
      classified.registry ?? "",
      classified.requirement ?? "",
      features,
    );
    if (!retained.ok) return retained;
    this.dependencies.push({
      dependency_id: identity("cargo_dependency", [
        this.artifact.sha256,
        pointer,
        key,
      ]),
      dependency_key: identity("cargo_dependency_key", [key, table.pointer]),
      name,
      alias,
      requirement: classified.requirement,
      source: classified.source,
      source_detail: classified.sourceDetail,
      registry: classified.registry,
      declared_by: declaredBy,
      optional: declaration.optional === true,
      default_features: defaultFeatures(
        declaration,
        classified.source,
        legacyStatus,
      ),
      features,
      target: table.target,
      source_pointer: pointer,
    });
    const problems = declarationProblems(declaration, legacyStatus);
    return problems.length === 0
      ? ok(undefined)
      : this.diagnostic(
          "invalid-dependency-declaration",
          pointer,
          `Dependency "${key}" declares ${problems.join("; ")}.`,
        );
  }
}

const rootFailure = (message: string) =>
  err(
    new AnalysisInputError(CARGO_MANIFEST_OPERATION, undefined, [
      { path: ["path"], reason: "invalid_format", message },
    ]),
  );

/**
 * Inventory declarations in one already-parsed manifest; nothing is resolved or
 * executed.
 */
// The body walks the manifest's independent optional sections (workspace,
// package, dependency tables, target tables, features); each section delegates
// its own semantics, so the length is structural rather than accumulated logic.
// eslint-disable-next-line max-lines-per-function, complexity
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

  if (table.workspace !== undefined && workspace === undefined)
    return rootFailure("[workspace] is present but is not a table.");
  if (table.package !== undefined && packageTable === undefined)
    return rootFailure("[package] is present but is not a table.");

  if (packageTable === undefined && workspace === undefined)
    return rootFailure(
      "Manifest declares neither a [package] nor a [workspace] table.",
    );

  // Members and exclusions are optional in Cargo; only a present wrong type is a
  // diagnostic. The shipping field is workspace.exclude, singular.
  const members = stringArray(workspace?.members) ?? [];
  const excludes = stringArray(workspace?.exclude) ?? [];
  // The workspace arrays are copied into the report verbatim, so they are
  // charged before they are retained rather than left outside the allowance.
  const workspaceAdmitted = inventory.retainSource(members, excludes);
  if (!workspaceAdmitted.ok) return workspaceAdmitted;
  for (const [field, present] of [
    ["members", workspace?.members],
    ["exclude", workspace?.exclude],
  ] as const)
    if (present !== undefined && stringArray(present) === undefined) {
      const recorded = inventory.diagnostic(
        "invalid-manifest-form",
        `/workspace/${field}`,
        `workspace.${field} is not an array of strings.`,
      );
      if (!recorded.ok) return recorded;
    }
  const dependencyTables: DependencyTable[] = [];
  const collectTables = (
    container: Record<string, unknown>,
    prefix: string,
    target: string | null,
  ): Result<void, AnalysisError> => {
    for (const name of DEPENDENCY_TABLES) {
      const entries = tableFailure(container[name]);
      if (entries === "absent") continue;
      if (entries === "malformed") {
        const recorded = inventory.diagnostic(
          "invalid-dependency-table",
          `${prefix}${name}`,
          `[${prefix.slice(1)}${name}] is present but is not a table.`,
        );
        if (!recorded.ok) return recorded;
        continue;
      }
      dependencyTables.push({
        pointer: `${prefix}${name}`,
        target,
        declaredBy: "package",
        entries,
      });
    }
    return ok(undefined);
  };

  const rootTables = collectTables(table, "/", null);
  if (!rootTables.ok) return rootTables;

  const targetField = tableFailure(table.target);
  if (targetField === "malformed") {
    const recorded = inventory.diagnostic(
      "invalid-dependency-table",
      "/target",
      "[target] is present but is not a table.",
    );
    if (!recorded.ok) return recorded;
  }
  if (targetField !== "absent" && targetField !== "malformed")
    for (const [condition, value] of Object.entries(targetField)) {
      const container = record(value);
      const pointer = `/target/${pointerPart(condition)}/`;
      if (container === undefined) {
        const recorded = inventory.diagnostic(
          "invalid-dependency-table",
          `/target/${pointerPart(condition)}`,
          `Target "${condition}" is not a table.`,
        );
        if (!recorded.ok) return recorded;
        continue;
      }
      const collected = collectTables(container, pointer, condition);
      if (!collected.ok) return collected;
    }

  if (workspace !== undefined) {
    const inherited = tableFailure(workspace.dependencies);
    if (inherited === "malformed") {
      const recorded = inventory.diagnostic(
        "invalid-dependency-table",
        "/workspace/dependencies",
        "workspace.dependencies is not a table.",
      );
      if (!recorded.ok) return recorded;
    } else if (inherited !== "absent")
      dependencyTables.push({
        pointer: "/workspace/dependencies",
        target: null,
        declaredBy: "workspace",
        entries: inherited,
      });
  }

  if (packageTable !== undefined) {
    const name = packageTable.name;
    if (typeof name !== "string")
      return rootFailure("[package].name is absent or is not a string.");
    // `version.workspace = true` and siblings inherit from a parent manifest that
    // this parser deliberately does not read; carry the intent instead of null.
    const inheritedSetting = (value: unknown): "inherited" | string | null => {
      if (typeof value === "string") return value;
      const nested = record(value);
      return nested?.workspace === true ? "inherited" : null;
    };
    // A setting that is present but is neither a string nor an inheritance is a
    // recorded value this parser cannot interpret. Nulling it would read as an
    // omitted setting, so name each one and keep the report partial.
    for (const field of ["version", "edition", "rust-version"]) {
      const value = packageTable[field];
      if (value === undefined || inheritedSetting(value) !== null) continue;
      const recorded = inventory.diagnostic(
        "invalid-package-table",
        `/package/${field}`,
        `[package].${field} is neither a string nor a \`workspace = true\` inheritance.`,
      );
      if (!recorded.ok) return recorded;
      if (field === "edition") inventory.packageEditionUnreadable = true;
    }
    const version = inheritedSetting(packageTable.version);
    const edition = inheritedSetting(packageTable.edition);
    const rustVersion = inheritedSetting(packageTable["rust-version"]);
    const admitted = inventory.retain(
      name,
      typeof version === "string" ? version : "",
      typeof edition === "string" ? edition : "",
      typeof rustVersion === "string" ? rustVersion : "",
    );
    if (!admitted.ok) return admitted;
    inventory.packages.push({
      package_id: identity("cargo_package", [artifact.sha256, name]),
      name,
      version,
      edition,
      rust_version: rustVersion,
      source_pointer: "/package",
      is_workspace_root: workspace !== undefined,
    });
  }

  for (const dependencyTable of dependencyTables)
    for (const [key, value] of Object.entries(dependencyTable.entries)) {
      const pointer = `${dependencyTable.pointer}/${pointerPart(key)}`;
      const added = inventory.dependency(key, value, dependencyTable, pointer);
      if (!added.ok) return added;
    }

  const featuresField = tableFailure(table.features);
  if (featuresField === "malformed") {
    const recorded = inventory.diagnostic(
      "invalid-feature-table",
      "/features",
      "[features] is present but is not a table.",
    );
    if (!recorded.ok) return recorded;
  }
  if (featuresField !== "absent" && featuresField !== "malformed")
    for (const [name, value] of Object.entries(featuresField)) {
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
      const pointer = `/features/${pointerPart(name)}`;
      const admitted = inventory.retainSource(name, pointer, enables);
      if (!admitted.ok) return admitted;
      inventory.features.push({
        name,
        enables,
        source_pointer: pointer,
      });
    }

  // `[patch]` and `[replace]` override dependency sources without appearing in
  // any dependency table, and this parser does not inventory them. Their
  // presence must make the scope partial rather than let it read complete.
  const uninventoriedOverrides = ["patch", "replace"].filter(
    (name) => table[name] !== undefined,
  );
  for (const name of uninventoriedOverrides) {
    const recorded = inventory.diagnostic(
      "unsupported-manifest-form",
      `/${name}`,
      `[${name}] overrides dependency sources and is not inventoried; source coverage is partial.`,
    );
    if (!recorded.ok) return recorded;
  }

  const count = (predicate: (dependency: CargoDependency) => boolean) =>
    inventory.dependencies.filter(predicate).length;

  return ok({
    manifest_id: `cargo_manifest_${artifact.sha256}`,
    format: "cargo-toml",
    artifact,
    workspace: {
      members,
      excludes,
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
      "A `workspace = true` declaration records inheritance without reading the parent workspace.",
      "`[patch]` and `[replace]` source overrides are not inventoried; their presence makes source coverage partial.",
    ],
  });
};
