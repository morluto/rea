import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { err, ok, type Result } from "../result.js";

export type CargoDependencyKind = "normal" | "dev" | "build" | "target";

export type CargoDependencySource =
  | {
      readonly type: "registry";
      readonly versionReq: string;
      readonly registry?: string;
    }
  | {
      readonly type: "path";
      readonly path: string;
      readonly versionReq?: string;
    }
  | {
      readonly type: "git";
      readonly git: string;
      readonly branch?: string;
      readonly tag?: string;
      readonly rev?: string;
      readonly versionReq?: string;
    }
  | {
      readonly type: "workspace";
      readonly versionReq?: string;
      readonly features?: readonly string[];
    };

export interface CargoDeclaredDependency {
  readonly name: string;
  readonly package: string;
  readonly kind: CargoDependencyKind;
  readonly targetCondition?: string;
  readonly optional: boolean;
  readonly defaultFeatures: boolean;
  readonly features: readonly string[];
  readonly source: CargoDependencySource;
}

export interface CargoDeclaredPackage {
  readonly name: string;
  readonly version: string;
  readonly edition?: string;
  readonly description?: string;
  readonly publish?: boolean;
  readonly rustVersion?: string;
  readonly dependencies: readonly CargoDeclaredDependency[];
  readonly features: Readonly<Record<string, readonly string[]>>;
}

export interface CargoWorkspace {
  readonly members: readonly string[];
  readonly defaultMembers?: readonly string[];
  readonly exclude?: readonly string[];
  readonly inheritedDependencies: Readonly<
    Record<string, CargoDeclaredDependency>
  >;
}

export interface CargoLockPackage {
  readonly name: string;
  readonly version: string;
  readonly source?: string;
  readonly checksum?: string;
  readonly dependencies: readonly string[];
}

export type CargoDiagnosticCode =
  | "missing_lockfile_package"
  | "unresolved_workspace_dependency"
  | "version_mismatch"
  | "unsupported_lockfile_version"
  | "feature_cycle";

export interface CargoReconciliationDiagnostic {
  readonly code: CargoDiagnosticCode;
  readonly message: string;
  readonly package: string;
  readonly dependency?: string;
}

export interface CargoDependencyGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: CargoDependencyKind;
  readonly optional: boolean;
  readonly features: readonly string[];
}

export interface CargoDependencyGraphNode {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly source?: string;
}

export interface CargoManifestEvidence {
  readonly workspace?: CargoWorkspace;
  readonly packages: readonly CargoDeclaredPackage[];
  readonly resolvedPackages: readonly CargoLockPackage[];
  readonly dependencyGraph: {
    readonly nodes: readonly CargoDependencyGraphNode[];
    readonly edges: readonly CargoDependencyGraphEdge[];
  };
  readonly diagnostics: readonly CargoReconciliationDiagnostic[];
}

export interface CargoManifestComparison {
  readonly addedPackages: readonly string[];
  readonly removedPackages: readonly string[];
  readonly changedPackages: readonly {
    readonly name: string;
    readonly beforeVersion?: string | undefined;
    readonly afterVersion?: string | undefined;
    readonly sourceChanged: boolean;
    readonly beforeSource?: string | undefined;
    readonly afterSource?: string | undefined;
    readonly addedDependencies: readonly string[];
    readonly removedDependencies: readonly string[];
  }[];
}

const parseDependencySource = (
  raw: unknown,
  key: string,
): {
  source: CargoDependencySource;
  package: string;
  optional: boolean;
  defaultFeatures: boolean;
  features: string[];
} => {
  if (typeof raw === "string") {
    return {
      source: { type: "registry", versionReq: raw },
      package: key,
      optional: false,
      defaultFeatures: true,
      features: [],
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return {
      source: { type: "registry", versionReq: "*" },
      package: key,
      optional: false,
      defaultFeatures: true,
      features: [],
    };
  }

  const record = raw as Record<string, unknown>;
  const pkgName =
    typeof record["package"] === "string" ? record["package"] : key;
  const optional = record["optional"] === true;
  const defaultFeatures = record["default-features"] !== false;
  const features = Array.isArray(record["features"])
    ? record["features"].filter((f): f is string => typeof f === "string")
    : [];

  if (record["workspace"] === true) {
    const versionReq =
      typeof record["version"] === "string" ? record["version"] : undefined;
    return {
      source: {
        type: "workspace",
        ...(versionReq ? { versionReq } : {}),
        ...(features.length > 0 ? { features } : {}),
      },
      package: pkgName,
      optional,
      defaultFeatures,
      features,
    };
  }

  if (typeof record["path"] === "string") {
    const versionReq =
      typeof record["version"] === "string" ? record["version"] : undefined;
    return {
      source: {
        type: "path",
        path: record["path"],
        ...(versionReq ? { versionReq } : {}),
      },
      package: pkgName,
      optional,
      defaultFeatures,
      features,
    };
  }

  if (typeof record["git"] === "string") {
    const versionReq =
      typeof record["version"] === "string" ? record["version"] : undefined;
    const branch =
      typeof record["branch"] === "string" ? record["branch"] : undefined;
    const tag = typeof record["tag"] === "string" ? record["tag"] : undefined;
    const rev = typeof record["rev"] === "string" ? record["rev"] : undefined;
    return {
      source: {
        type: "git",
        git: record["git"],
        ...(branch ? { branch } : {}),
        ...(tag ? { tag } : {}),
        ...(rev ? { rev } : {}),
        ...(versionReq ? { versionReq } : {}),
      },
      package: pkgName,
      optional,
      defaultFeatures,
      features,
    };
  }

  const versionReq =
    typeof record["version"] === "string" ? record["version"] : "*";
  const registry =
    typeof record["registry"] === "string" ? record["registry"] : undefined;
  return {
    source: { type: "registry", versionReq, ...(registry ? { registry } : {}) },
    package: pkgName,
    optional,
    defaultFeatures,
    features,
  };
};

const extractDependenciesFromTable = (
  table: unknown,
  kind: CargoDependencyKind,
  targetCondition?: string,
): CargoDeclaredDependency[] => {
  if (typeof table !== "object" || table === null) return [];
  const entries: CargoDeclaredDependency[] = [];
  for (const [key, raw] of Object.entries(table as Record<string, unknown>)) {
    const parsed = parseDependencySource(raw, key);
    entries.push({
      name: key,
      package: parsed.package,
      kind,
      ...(targetCondition ? { targetCondition } : {}),
      optional: parsed.optional,
      defaultFeatures: parsed.defaultFeatures,
      features: parsed.features,
      source: parsed.source,
    });
  }
  return entries;
};

const extractTargetDependencies = (
  table: unknown,
): CargoDeclaredDependency[] => {
  if (typeof table !== "object" || table === null) return [];
  const result: CargoDeclaredDependency[] = [];
  for (const [targetKey, targetVal] of Object.entries(
    table as Record<string, unknown>,
  )) {
    if (typeof targetVal !== "object" || targetVal === null) continue;
    const tRec = targetVal as Record<string, unknown>;
    result.push(
      ...extractDependenciesFromTable(
        tRec["dependencies"],
        "target",
        targetKey,
      ),
      ...extractDependenciesFromTable(
        tRec["dev-dependencies"],
        "target",
        targetKey,
      ),
      ...extractDependenciesFromTable(
        tRec["build-dependencies"],
        "target",
        targetKey,
      ),
    );
  }
  return result;
};

const detectFeatureCycles = (
  features: Readonly<Record<string, readonly string[]>>,
  packageName: string,
): CargoReconciliationDiagnostic[] => {
  const diagnostics: CargoReconciliationDiagnostic[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const dfs = (feat: string, path: string[]) => {
    visited.add(feat);
    inStack.add(feat);
    const subFeatures = features[feat] ?? [];
    for (const sub of subFeatures) {
      const cleanSub = sub.startsWith("dep:")
        ? sub.slice(4)
        : (sub.split("/")[0] ?? sub);
      if (!features[cleanSub]) continue;
      if (inStack.has(cleanSub)) {
        diagnostics.push({
          code: "feature_cycle",
          message: `Feature cycle detected in package "${packageName}": ${[...path, feat, cleanSub].join(" -> ")}`,
          package: packageName,
        });
      } else if (!visited.has(cleanSub)) {
        dfs(cleanSub, [...path, feat]);
      }
    }
    inStack.delete(feat);
  };

  for (const rootFeat of Object.keys(features)) {
    if (!visited.has(rootFeat)) {
      dfs(rootFeat, []);
    }
  }

  return diagnostics;
};

export const parseCargoToml = (
  tomlText: string,
): Result<
  { package?: CargoDeclaredPackage; workspace?: CargoWorkspace },
  Error
> => {
  try {
    const raw = parseToml(tomlText) as Record<string, unknown>;
    let pkg: CargoDeclaredPackage | undefined;
    let workspace: CargoWorkspace | undefined;

    if (typeof raw["package"] === "object" && raw["package"] !== null) {
      const p = raw["package"] as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const version = typeof p["version"] === "string" ? p["version"] : "0.0.0";
      const edition =
        typeof p["edition"] === "string" ? p["edition"] : undefined;
      const description =
        typeof p["description"] === "string" ? p["description"] : undefined;
      const publish =
        typeof p["publish"] === "boolean" ? p["publish"] : undefined;
      const rustVersion =
        typeof p["rust-version"] === "string" ? p["rust-version"] : undefined;

      const deps: CargoDeclaredDependency[] = [
        ...extractDependenciesFromTable(raw["dependencies"], "normal"),
        ...extractDependenciesFromTable(raw["dev-dependencies"], "dev"),
        ...extractDependenciesFromTable(raw["build-dependencies"], "build"),
        ...extractTargetDependencies(raw["target"]),
      ];

      const features: Record<string, string[]> = {};
      if (typeof raw["features"] === "object" && raw["features"] !== null) {
        for (const [feat, featList] of Object.entries(
          raw["features"] as Record<string, unknown>,
        )) {
          if (Array.isArray(featList)) {
            features[feat] = featList.filter(
              (item): item is string => typeof item === "string",
            );
          }
        }
      }

      pkg = {
        name,
        version,
        ...(edition ? { edition } : {}),
        ...(description ? { description } : {}),
        ...(publish !== undefined ? { publish } : {}),
        ...(rustVersion ? { rustVersion } : {}),
        dependencies: deps,
        features,
      };
    }

    if (typeof raw["workspace"] === "object" && raw["workspace"] !== null) {
      const w = raw["workspace"] as Record<string, unknown>;
      const members = Array.isArray(w["members"])
        ? w["members"].filter((m): m is string => typeof m === "string")
        : [];
      const defaultMembers = Array.isArray(w["default-members"])
        ? w["default-members"].filter((m): m is string => typeof m === "string")
        : [];
      const exclude = Array.isArray(w["exclude"])
        ? w["exclude"].filter((m): m is string => typeof m === "string")
        : [];

      const inheritedDependencies: Record<string, CargoDeclaredDependency> = {};
      if (typeof w["dependencies"] === "object" && w["dependencies"] !== null) {
        for (const dep of extractDependenciesFromTable(
          w["dependencies"],
          "normal",
        )) {
          inheritedDependencies[dep.name] = dep;
        }
      }

      workspace = {
        members,
        ...(defaultMembers.length > 0 ? { defaultMembers } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
        inheritedDependencies,
      };
    }

    return ok({
      ...(pkg ? { package: pkg } : {}),
      ...(workspace ? { workspace } : {}),
    });
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
};

export const parseCargoLock = (
  lockText: string,
): Result<
  { version: number; packages: readonly CargoLockPackage[] },
  Error
> => {
  try {
    const raw = parseToml(lockText) as Record<string, unknown>;
    const rawVersion = raw["version"];
    const version = typeof rawVersion === "number" ? rawVersion : 1;

    if (version < 1 || version > 4) {
      return err(new Error(`Unsupported Cargo.lock version: ${version}`));
    }

    const packages: CargoLockPackage[] = [];
    if (Array.isArray(raw["package"])) {
      for (const item of raw["package"]) {
        if (typeof item !== "object" || item === null) continue;
        const p = item as Record<string, unknown>;
        const name = typeof p["name"] === "string" ? p["name"] : "";
        const pkgVer = typeof p["version"] === "string" ? p["version"] : "";
        const source =
          typeof p["source"] === "string" ? p["source"] : undefined;
        const checksum =
          typeof p["checksum"] === "string" ? p["checksum"] : undefined;
        const dependencies = Array.isArray(p["dependencies"])
          ? p["dependencies"].filter((d): d is string => typeof d === "string")
          : [];
        packages.push({
          name,
          version: pkgVer,
          ...(source ? { source } : {}),
          ...(checksum ? { checksum } : {}),
          dependencies,
        });
      }
    }

    return ok({ version, packages });
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
};

export interface InspectCargoProjectOptions {
  readonly rootToml: string;
  readonly lockfile?: string;
  readonly memberTomls?: Readonly<Record<string, string>>;
}

export const inspectCargoProject = (
  options: InspectCargoProjectOptions,
): Result<CargoManifestEvidence, Error> => {
  const rootParsed = parseCargoToml(options.rootToml);
  if (!rootParsed.ok) return err(rootParsed.error);

  const packages: CargoDeclaredPackage[] = [];
  const diagnostics: CargoReconciliationDiagnostic[] = [];

  const workspace = rootParsed.value.workspace;
  if (rootParsed.value.package) {
    packages.push(rootParsed.value.package);
  }

  if (options.memberTomls) {
    for (const [memberPath, tomlContent] of Object.entries(
      options.memberTomls,
    )) {
      const parsed = parseCargoToml(tomlContent);
      if (parsed.ok && parsed.value.package) {
        packages.push(parsed.value.package);
      } else if (!parsed.ok) {
        diagnostics.push({
          code: "unresolved_workspace_dependency",
          message: `Failed to parse workspace member Cargo.toml at "${memberPath}": ${parsed.error.message}`,
          package: memberPath,
        });
      }
    }
  }

  // Reconcile workspace inherited dependencies
  for (const pkg of packages) {
    for (const dep of pkg.dependencies) {
      if (dep.source.type === "workspace") {
        if (!workspace || !workspace.inheritedDependencies[dep.name]) {
          diagnostics.push({
            code: "unresolved_workspace_dependency",
            message: `Package "${pkg.name}" inherits dependency "${dep.name}" from workspace, but it is not declared in [workspace.dependencies].`,
            package: pkg.name,
            dependency: dep.name,
          });
        }
      }
    }
    diagnostics.push(...detectFeatureCycles(pkg.features, pkg.name));
  }

  // Parse lockfile if provided
  let resolvedPackages: CargoLockPackage[] = [];
  if (options.lockfile !== undefined) {
    const lockParsed = parseCargoLock(options.lockfile);
    if (!lockParsed.ok) {
      diagnostics.push({
        code: "unsupported_lockfile_version",
        message: lockParsed.error.message,
        package: "Cargo.lock",
      });
    } else {
      resolvedPackages = [...lockParsed.value.packages];
      const lockMap = new Map<string, CargoLockPackage[]>();
      for (const lp of resolvedPackages) {
        const existing = lockMap.get(lp.name) ?? [];
        existing.push(lp);
        lockMap.set(lp.name, existing);
      }

      for (const pkg of packages) {
        for (const dep of pkg.dependencies) {
          const lockMatches = lockMap.get(dep.package);
          if (!lockMatches || lockMatches.length === 0) {
            diagnostics.push({
              code: "missing_lockfile_package",
              message: `Declared dependency "${dep.package}" in package "${pkg.name}" is missing from Cargo.lock.`,
              package: pkg.name,
              dependency: dep.package,
            });
          }
        }
      }
    }
  }

  // Build dependency graph
  const nodesMap = new Map<string, CargoDependencyGraphNode>();
  const edges: CargoDependencyGraphEdge[] = [];

  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    nodesMap.set(id, { id, name: pkg.name, version: pkg.version });
    for (const dep of pkg.dependencies) {
      edges.push({
        from: id,
        to: dep.package,
        kind: dep.kind,
        optional: dep.optional,
        features: dep.features,
      });
    }
  }

  for (const lp of resolvedPackages) {
    const id = `${lp.name}@${lp.version}`;
    if (!nodesMap.has(id)) {
      nodesMap.set(id, {
        id,
        name: lp.name,
        version: lp.version,
        ...(lp.source ? { source: lp.source } : {}),
      });
    }
    for (const depStr of lp.dependencies) {
      const depName = depStr.split(" ")[0] ?? depStr;
      edges.push({
        from: id,
        to: depName,
        kind: "normal",
        optional: false,
        features: [],
      });
    }
  }

  return ok({
    ...(workspace ? { workspace } : {}),
    packages,
    resolvedPackages,
    dependencyGraph: {
      nodes: Array.from(nodesMap.values()),
      edges,
    },
    diagnostics,
  });
};

export const compareCargoManifestEvidence = (
  before: CargoManifestEvidence,
  after: CargoManifestEvidence,
): CargoManifestComparison => {
  const beforePkgs = new Map(before.packages.map((p) => [p.name, p]));
  const afterPkgs = new Map(after.packages.map((p) => [p.name, p]));

  const addedPackages: string[] = [];
  const removedPackages: string[] = [];
  const changedPackages: CargoManifestComparison["changedPackages"][number][] =
    [];

  for (const name of afterPkgs.keys()) {
    if (!beforePkgs.has(name)) {
      addedPackages.push(name);
    }
  }

  for (const [name, bPkg] of beforePkgs) {
    const aPkg = afterPkgs.get(name);
    if (!aPkg) {
      removedPackages.push(name);
      continue;
    }

    const bDeps = new Set(bPkg.dependencies.map((d) => d.name));
    const aDeps = new Set(aPkg.dependencies.map((d) => d.name));

    const addedDependencies = Array.from(aDeps).filter((d) => !bDeps.has(d));
    const removedDependencies = Array.from(bDeps).filter((d) => !aDeps.has(d));

    const bLock = before.resolvedPackages.find((p) => p.name === name);
    const aLock = after.resolvedPackages.find((p) => p.name === name);

    const sourceChanged = bLock?.source !== aLock?.source;

    if (
      bPkg.version !== aPkg.version ||
      sourceChanged ||
      addedDependencies.length > 0 ||
      removedDependencies.length > 0
    ) {
      changedPackages.push({
        name,
        beforeVersion: bPkg.version,
        afterVersion: aPkg.version,
        sourceChanged,
        ...(bLock?.source !== undefined ? { beforeSource: bLock.source } : {}),
        ...(aLock?.source !== undefined ? { afterSource: aLock.source } : {}),
        addedDependencies,
        removedDependencies,
      });
    }
  }

  return {
    addedPackages,
    removedPackages,
    changedPackages,
  };
};

export const cargoDeclaredDependencySchema = z.strictObject({
  name: z.string().min(1),
  package: z.string().min(1),
  kind: z.enum(["normal", "dev", "build", "target"]),
  targetCondition: z.string().optional(),
  optional: z.boolean(),
  defaultFeatures: z.boolean(),
  features: z.array(z.string()),
  source: z.union([
    z.strictObject({
      type: z.literal("registry"),
      versionReq: z.string(),
      registry: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("path"),
      path: z.string(),
      versionReq: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("git"),
      git: z.string(),
      branch: z.string().optional(),
      tag: z.string().optional(),
      rev: z.string().optional(),
      versionReq: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("workspace"),
      versionReq: z.string().optional(),
      features: z.array(z.string()).optional(),
    }),
  ]),
});

export const cargoManifestEvidenceSchema = z.strictObject({
  workspace: z
    .strictObject({
      members: z.array(z.string()),
      defaultMembers: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      inheritedDependencies: z.record(
        z.string(),
        cargoDeclaredDependencySchema,
      ),
    })
    .optional(),
  packages: z.array(
    z.strictObject({
      name: z.string(),
      version: z.string(),
      edition: z.string().optional(),
      description: z.string().optional(),
      publish: z.boolean().optional(),
      rustVersion: z.string().optional(),
      dependencies: z.array(cargoDeclaredDependencySchema),
      features: z.record(z.string(), z.array(z.string())),
    }),
  ),
  resolvedPackages: z.array(
    z.strictObject({
      name: z.string(),
      version: z.string(),
      source: z.string().optional(),
      checksum: z.string().optional(),
      dependencies: z.array(z.string()),
    }),
  ),
  dependencyGraph: z.strictObject({
    nodes: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        version: z.string().optional(),
        source: z.string().optional(),
      }),
    ),
    edges: z.array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        kind: z.enum(["normal", "dev", "build", "target"]),
        optional: z.boolean(),
        features: z.array(z.string()),
      }),
    ),
  }),
  diagnostics: z.array(
    z.strictObject({
      code: z.enum([
        "missing_lockfile_package",
        "unresolved_workspace_dependency",
        "version_mismatch",
        "unsupported_lockfile_version",
        "feature_cycle",
      ]),
      message: z.string(),
      package: z.string(),
      dependency: z.string().optional(),
    }),
  ),
});
