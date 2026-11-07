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
  readonly publish?: boolean | readonly string[];
  readonly rustVersion?: string;
  readonly dependencies: readonly CargoDeclaredDependency[];
  readonly features: Readonly<Record<string, readonly string[]>>;
  readonly inheritedFromWorkspace?: {
    readonly version?: boolean;
    readonly edition?: boolean;
    readonly description?: boolean;
    readonly publish?: boolean;
    readonly rustVersion?: boolean;
  };
}

export interface CargoWorkspacePackageMetadata {
  readonly version?: string;
  readonly edition?: string;
  readonly description?: string;
  readonly publish?: boolean | readonly string[];
  readonly rustVersion?: string;
}

export interface CargoWorkspace {
  readonly members: readonly string[];
  readonly defaultMembers?: readonly string[];
  readonly exclude?: readonly string[];
  readonly packageMetadata?: CargoWorkspacePackageMetadata;
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
  | "invalid_lockfile_syntax"
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
  readonly targetCondition?: string;
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
  readonly unreadableMembers?: readonly string[];
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
    readonly changedDependencies?: readonly string[];
  }[];
  readonly addedResolvedPackages?: readonly string[];
  readonly removedResolvedPackages?: readonly string[];
  readonly changedResolvedPackages?: readonly {
    readonly name: string;
    readonly beforeVersion: string;
    readonly afterVersion: string;
    readonly sourceChanged: boolean;
    readonly beforeSource?: string | undefined;
    readonly afterSource?: string | undefined;
  }[];
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const parseSemVer = (versionStr: string): SemVer | undefined => {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(versionStr.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1] ?? 0),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
};

const compareSemVer = (a: SemVer, b: SemVer): number => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
};

export const satisfiesCargoReq = (
  versionStr: string,
  reqStr: string,
): boolean => {
  const trimmedReq = reqStr.trim();
  if (trimmedReq === "*" || trimmedReq === "") return true;
  const version = parseSemVer(versionStr);
  if (!version) return false;

  const parts = trimmedReq
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return parts.every((part) => satisfiesCargoReq(versionStr, part));
  }

  const single = parts[0] ?? trimmedReq;
  if (single.startsWith("=")) {
    const target = parseSemVer(single.slice(1));
    return target !== undefined && compareSemVer(version, target) === 0;
  }
  if (single.startsWith(">=")) {
    const target = parseSemVer(single.slice(2));
    return target !== undefined && compareSemVer(version, target) >= 0;
  }
  if (single.startsWith(">")) {
    const target = parseSemVer(single.slice(1));
    return target !== undefined && compareSemVer(version, target) > 0;
  }
  if (single.startsWith("<=")) {
    const target = parseSemVer(single.slice(2));
    return target !== undefined && compareSemVer(version, target) <= 0;
  }
  if (single.startsWith("<")) {
    const target = parseSemVer(single.slice(1));
    return target !== undefined && compareSemVer(version, target) < 0;
  }
  if (single.startsWith("~")) {
    const target = parseSemVer(single.slice(1));
    if (!target) return false;
    if (compareSemVer(version, target) < 0) return false;
    return version.major === target.major && version.minor === target.minor;
  }

  const reqClean = single.startsWith("^") ? single.slice(1) : single;
  const target = parseSemVer(reqClean);
  if (!target) return false;
  if (compareSemVer(version, target) < 0) return false;

  if (target.major > 0) {
    return version.major === target.major;
  }
  if (target.minor > 0) {
    return version.major === 0 && version.minor === target.minor;
  }
  return (
    version.major === 0 && version.minor === 0 && version.patch === target.patch
  );
};

const parseDependencySource = (
  raw: unknown,
  key: string,
): Result<
  {
    source: CargoDependencySource;
    package: string;
    optional: boolean;
    defaultFeatures: boolean;
    features: string[];
  },
  Error
> => {
  if (typeof raw === "string") {
    return ok({
      source: { type: "registry", versionReq: raw },
      package: key,
      optional: false,
      defaultFeatures: true,
      features: [],
    });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(
      new Error(
        `Invalid dependency declaration for "${key}": expected version string or table, received ${Array.isArray(raw) ? "array" : typeof raw}`,
      ),
    );
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
    return ok({
      source: {
        type: "workspace",
        ...(versionReq ? { versionReq } : {}),
        ...(features.length > 0 ? { features } : {}),
      },
      package: pkgName,
      optional,
      defaultFeatures,
      features,
    });
  }

  if (typeof record["path"] === "string") {
    const versionReq =
      typeof record["version"] === "string" ? record["version"] : undefined;
    return ok({
      source: {
        type: "path",
        path: record["path"],
        ...(versionReq ? { versionReq } : {}),
      },
      package: pkgName,
      optional,
      defaultFeatures,
      features,
    });
  }

  if (typeof record["git"] === "string") {
    const versionReq =
      typeof record["version"] === "string" ? record["version"] : undefined;
    const branch =
      typeof record["branch"] === "string" ? record["branch"] : undefined;
    const tag = typeof record["tag"] === "string" ? record["tag"] : undefined;
    const rev = typeof record["rev"] === "string" ? record["rev"] : undefined;
    return ok({
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
    });
  }

  const versionReq =
    typeof record["version"] === "string" ? record["version"] : "*";
  const registry =
    typeof record["registry"] === "string" ? record["registry"] : undefined;
  return ok({
    source: { type: "registry", versionReq, ...(registry ? { registry } : {}) },
    package: pkgName,
    optional,
    defaultFeatures,
    features,
  });
};

const extractDependenciesFromTable = (
  table: unknown,
  kind: CargoDependencyKind,
  targetCondition?: string,
): Result<CargoDeclaredDependency[], Error> => {
  if (typeof table !== "object" || table === null) return ok([]);
  const entries: CargoDeclaredDependency[] = [];
  for (const [key, raw] of Object.entries(table as Record<string, unknown>)) {
    const parsed = parseDependencySource(raw, key);
    if (!parsed.ok) return err(parsed.error);
    entries.push({
      name: key,
      package: parsed.value.package,
      kind,
      ...(targetCondition ? { targetCondition } : {}),
      optional: parsed.value.optional,
      defaultFeatures: parsed.value.defaultFeatures,
      features: parsed.value.features,
      source: parsed.value.source,
    });
  }
  return ok(entries);
};

const extractTargetDependencies = (
  table: unknown,
): Result<CargoDeclaredDependency[], Error> => {
  if (typeof table !== "object" || table === null) return ok([]);
  const result: CargoDeclaredDependency[] = [];
  for (const [targetKey, targetVal] of Object.entries(
    table as Record<string, unknown>,
  )) {
    if (typeof targetVal !== "object" || targetVal === null) continue;
    const tRec = targetVal as Record<string, unknown>;
    const normal = extractDependenciesFromTable(
      tRec["dependencies"],
      "normal",
      targetKey,
    );
    if (!normal.ok) return err(normal.error);
    const dev = extractDependenciesFromTable(
      tRec["dev-dependencies"],
      "dev",
      targetKey,
    );
    if (!dev.ok) return err(dev.error);
    const build = extractDependenciesFromTable(
      tRec["build-dependencies"],
      "build",
      targetKey,
    );
    if (!build.ok) return err(build.error);

    result.push(...normal.value, ...dev.value, ...build.value);
  }
  return ok(result);
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
    const subFeatures = Object.hasOwn(features, feat)
      ? (features[feat] ?? [])
      : [];
    for (const sub of subFeatures) {
      if (sub.startsWith("dep:") || sub.includes("/") || sub.endsWith("?")) {
        continue;
      }
      if (!Object.hasOwn(features, sub)) continue;
      if (inStack.has(sub)) {
        diagnostics.push({
          code: "feature_cycle",
          message: `Feature cycle detected in package "${packageName}": ${[...path, feat, sub].join(" -> ")}`,
          package: packageName,
        });
      } else if (!visited.has(sub)) {
        dfs(sub, [...path, feat]);
      }
    }
    inStack.delete(feat);
  };

  for (const rootFeat of Object.keys(features)) {
    if (Object.hasOwn(features, rootFeat) && !visited.has(rootFeat)) {
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

      let packageMetadata: CargoWorkspacePackageMetadata | undefined;
      if (typeof w["package"] === "object" && w["package"] !== null) {
        const wp = w["package"] as Record<string, unknown>;
        const wpVersion =
          typeof wp["version"] === "string" ? wp["version"] : undefined;
        const wpEdition =
          typeof wp["edition"] === "string" ? wp["edition"] : undefined;
        const wpDescription =
          typeof wp["description"] === "string" ? wp["description"] : undefined;
        const wpPublish =
          typeof wp["publish"] === "boolean"
            ? wp["publish"]
            : Array.isArray(wp["publish"])
              ? wp["publish"].filter((x): x is string => typeof x === "string")
              : undefined;
        const wpRustVersion =
          typeof wp["rust-version"] === "string"
            ? wp["rust-version"]
            : undefined;

        packageMetadata = {
          ...(wpVersion !== undefined ? { version: wpVersion } : {}),
          ...(wpEdition !== undefined ? { edition: wpEdition } : {}),
          ...(wpDescription !== undefined
            ? { description: wpDescription }
            : {}),
          ...(wpPublish !== undefined ? { publish: wpPublish } : {}),
          ...(wpRustVersion !== undefined
            ? { rustVersion: wpRustVersion }
            : {}),
        };
      }

      const inheritedDependencies: Record<string, CargoDeclaredDependency> =
        Object.create(null);
      if (typeof w["dependencies"] === "object" && w["dependencies"] !== null) {
        const extracted = extractDependenciesFromTable(
          w["dependencies"],
          "normal",
        );
        if (!extracted.ok) return err(extracted.error);
        for (const dep of extracted.value) {
          inheritedDependencies[dep.name] = dep;
        }
      }

      workspace = {
        members,
        ...(defaultMembers.length > 0 ? { defaultMembers } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
        ...(packageMetadata !== undefined ? { packageMetadata } : {}),
        inheritedDependencies,
      };
    }

    if (typeof raw["package"] === "object" && raw["package"] !== null) {
      const p = raw["package"] as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";

      const versionWorkspace =
        typeof p["version"] === "object" &&
        p["version"] !== null &&
        (p["version"] as Record<string, unknown>)["workspace"] === true;
      const version =
        typeof p["version"] === "string"
          ? p["version"]
          : versionWorkspace && workspace?.packageMetadata?.version
            ? workspace.packageMetadata.version
            : "0.0.0";

      const editionWorkspace =
        typeof p["edition"] === "object" &&
        p["edition"] !== null &&
        (p["edition"] as Record<string, unknown>)["workspace"] === true;
      const edition =
        typeof p["edition"] === "string"
          ? p["edition"]
          : editionWorkspace && workspace?.packageMetadata?.edition
            ? workspace.packageMetadata.edition
            : undefined;

      const descriptionWorkspace =
        typeof p["description"] === "object" &&
        p["description"] !== null &&
        (p["description"] as Record<string, unknown>)["workspace"] === true;
      const description =
        typeof p["description"] === "string"
          ? p["description"]
          : descriptionWorkspace && workspace?.packageMetadata?.description
            ? workspace.packageMetadata.description
            : undefined;

      const publishWorkspace =
        typeof p["publish"] === "object" &&
        p["publish"] !== null &&
        (p["publish"] as Record<string, unknown>)["workspace"] === true;
      const publish =
        typeof p["publish"] === "boolean"
          ? p["publish"]
          : Array.isArray(p["publish"])
            ? p["publish"].filter((x): x is string => typeof x === "string")
            : publishWorkspace &&
                workspace?.packageMetadata?.publish !== undefined
              ? workspace.packageMetadata.publish
              : undefined;

      const rustVersionWorkspace =
        typeof p["rust-version"] === "object" &&
        p["rust-version"] !== null &&
        (p["rust-version"] as Record<string, unknown>)["workspace"] === true;
      const rustVersion =
        typeof p["rust-version"] === "string"
          ? p["rust-version"]
          : rustVersionWorkspace && workspace?.packageMetadata?.rustVersion
            ? workspace.packageMetadata.rustVersion
            : undefined;

      const normalDeps = extractDependenciesFromTable(
        raw["dependencies"],
        "normal",
      );
      if (!normalDeps.ok) return err(normalDeps.error);
      const devDeps = extractDependenciesFromTable(
        raw["dev-dependencies"],
        "dev",
      );
      if (!devDeps.ok) return err(devDeps.error);
      const buildDeps = extractDependenciesFromTable(
        raw["build-dependencies"],
        "build",
      );
      if (!buildDeps.ok) return err(buildDeps.error);
      const targetDeps = extractTargetDependencies(raw["target"]);
      if (!targetDeps.ok) return err(targetDeps.error);

      const deps: CargoDeclaredDependency[] = [
        ...normalDeps.value,
        ...devDeps.value,
        ...buildDeps.value,
        ...targetDeps.value,
      ];

      const features: Record<string, string[]> = Object.create(null);
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
        inheritedFromWorkspace: {
          ...(versionWorkspace ? { version: true } : {}),
          ...(editionWorkspace ? { edition: true } : {}),
          ...(descriptionWorkspace ? { description: true } : {}),
          ...(publishWorkspace ? { publish: true } : {}),
          ...(rustVersionWorkspace ? { rustVersion: true } : {}),
        },
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
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(lockText) as Record<string, unknown>;
  } catch (cause) {
    return err(
      new Error(
        `Failed to parse Cargo.lock syntax: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }

  const rawVersion = raw["version"];
  const version = typeof rawVersion === "number" ? rawVersion : 1;

  if (version < 1 || version > 4) {
    return err(new Error(`Unsupported Cargo.lock version: ${version}`));
  }

  const packages: CargoLockPackage[] = [];
  const metadata =
    typeof raw["metadata"] === "object" && raw["metadata"] !== null
      ? (raw["metadata"] as Record<string, unknown>)
      : undefined;

  if (Array.isArray(raw["package"])) {
    for (const item of raw["package"]) {
      if (typeof item !== "object" || item === null) continue;
      const p = item as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const pkgVer = typeof p["version"] === "string" ? p["version"] : "";
      const source = typeof p["source"] === "string" ? p["source"] : undefined;
      let checksum =
        typeof p["checksum"] === "string" ? p["checksum"] : undefined;

      if (!checksum && metadata) {
        const keyWithSource = `checksum ${name} ${pkgVer} (${source})`;
        const keyWithoutSource = `checksum ${name} ${pkgVer}`;
        const metaVal = metadata[keyWithSource] ?? metadata[keyWithoutSource];
        if (typeof metaVal === "string") {
          checksum = metaVal;
        }
      }

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
};

export interface InspectCargoProjectOptions {
  readonly rootToml: string;
  readonly lockfile?: string;
  readonly memberTomls?: Readonly<Record<string, string>>;
}

const parseLockDepString = (
  depStr: string,
): { name: string; version?: string; source?: string } => {
  const match = /^([^\s]+)(?:\s+([^\s(]+))?(?:\s+\(([^)]+)\))?$/.exec(
    depStr.trim(),
  );
  if (!match) return { name: depStr };
  return {
    name: match[1]!,
    ...(match[2] ? { version: match[2] } : {}),
    ...(match[3] ? { source: match[3] } : {}),
  };
};

const makeNodeId = (name: string, version?: string, source?: string): string =>
  `${name}${version ? `@${version}` : ""}${source ? `(${source})` : ""}`;

const reconcilePackageLockfile = (
  pkg: CargoDeclaredPackage,
  lockMap: Map<string, CargoLockPackage[]>,
  diagnostics: CargoReconciliationDiagnostic[],
): void => {
  for (const dep of pkg.dependencies) {
    const lockMatches = lockMap.get(dep.package);
    if (!lockMatches || lockMatches.length === 0) {
      diagnostics.push({
        code: "missing_lockfile_package",
        message: `Declared dependency "${dep.package}" in package "${pkg.name}" is missing from Cargo.lock.`,
        package: pkg.name,
        dependency: dep.package,
      });
      continue;
    }
    const req =
      dep.source.type === "registry"
        ? dep.source.versionReq
        : dep.source.type === "path" || dep.source.type === "git"
          ? dep.source.versionReq
          : undefined;
    if (req && req !== "*") {
      const anySatisfies = lockMatches.some((m) =>
        satisfiesCargoReq(m.version, req),
      );
      if (!anySatisfies) {
        diagnostics.push({
          code: "version_mismatch",
          message: `Locked versions [${lockMatches.map((m) => m.version).join(", ")}] for dependency "${dep.package}" in package "${pkg.name}" do not satisfy requirement "${req}".`,
          package: pkg.name,
          dependency: dep.package,
        });
      }
    }
  }
};

export const inspectCargoProject = (
  options: InspectCargoProjectOptions,
): Result<CargoManifestEvidence, Error> => {
  const rootParsed = parseCargoToml(options.rootToml);
  if (!rootParsed.ok) return err(rootParsed.error);

  const rawPackages: CargoDeclaredPackage[] = [];
  const diagnostics: CargoReconciliationDiagnostic[] = [];
  const unreadableMembers: string[] = [];

  const workspace = rootParsed.value.workspace;
  if (rootParsed.value.package) {
    rawPackages.push(rootParsed.value.package);
  }

  if (options.memberTomls) {
    for (const [memberPath, tomlContent] of Object.entries(
      options.memberTomls,
    )) {
      const parsed = parseCargoToml(tomlContent);
      if (parsed.ok && parsed.value.package) {
        rawPackages.push(parsed.value.package);
      } else if (!parsed.ok) {
        unreadableMembers.push(memberPath);
        diagnostics.push({
          code: "unresolved_workspace_dependency",
          message: `Failed to parse workspace member Cargo.toml at "${memberPath}": ${parsed.error.message}`,
          package: memberPath,
        });
      }
    }
  }

  // Resolve workspace metadata and inherited dependencies for each package
  const packages: CargoDeclaredPackage[] = [];
  for (const pkg of rawPackages) {
    const wm = workspace?.packageMetadata;
    const version =
      pkg.inheritedFromWorkspace?.version && wm?.version
        ? wm.version
        : pkg.version;
    const edition =
      pkg.inheritedFromWorkspace?.edition && wm?.edition !== undefined
        ? wm.edition
        : pkg.edition;
    const description =
      pkg.inheritedFromWorkspace?.description && wm?.description !== undefined
        ? wm.description
        : pkg.description;
    const publish =
      pkg.inheritedFromWorkspace?.publish && wm?.publish !== undefined
        ? wm.publish
        : pkg.publish;
    const rustVersion =
      pkg.inheritedFromWorkspace?.rustVersion && wm?.rustVersion !== undefined
        ? wm.rustVersion
        : pkg.rustVersion;

    const resolvedDeps: CargoDeclaredDependency[] = [];
    for (const dep of pkg.dependencies) {
      if (dep.source.type === "workspace") {
        const inherited = workspace?.inheritedDependencies[dep.name];
        if (!inherited) {
          diagnostics.push({
            code: "unresolved_workspace_dependency",
            message: `Package "${pkg.name}" inherits dependency "${dep.name}" from workspace, but it is not declared in [workspace.dependencies].`,
            package: pkg.name,
            dependency: dep.name,
          });
          resolvedDeps.push(dep);
        } else {
          const effectiveFeatures = Array.from(
            new Set([...inherited.features, ...dep.features]),
          );
          resolvedDeps.push({
            name: dep.name,
            package: inherited.package,
            kind: dep.kind,
            ...(dep.targetCondition
              ? { targetCondition: dep.targetCondition }
              : inherited.targetCondition
                ? { targetCondition: inherited.targetCondition }
                : {}),
            optional: dep.optional || inherited.optional,
            defaultFeatures: dep.defaultFeatures && inherited.defaultFeatures,
            features: effectiveFeatures,
            source: inherited.source,
          });
        }
      } else {
        resolvedDeps.push(dep);
      }
    }

    packages.push({
      ...pkg,
      version,
      ...(edition !== undefined ? { edition } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(publish !== undefined ? { publish } : {}),
      ...(rustVersion !== undefined ? { rustVersion } : {}),
      dependencies: resolvedDeps,
    });
    diagnostics.push(...detectFeatureCycles(pkg.features, pkg.name));
  }

  // Parse lockfile if provided
  let resolvedPackages: CargoLockPackage[] = [];
  if (options.lockfile !== undefined) {
    const lockParsed = parseCargoLock(options.lockfile);
    if (!lockParsed.ok) {
      const isVersionError = lockParsed.error.message.startsWith(
        "Unsupported Cargo.lock version",
      );
      diagnostics.push({
        code: isVersionError
          ? "unsupported_lockfile_version"
          : "invalid_lockfile_syntax",
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
        reconcilePackageLockfile(pkg, lockMap, diagnostics);
      }
    }
  }

  // Build dependency graph
  const nodesMap = new Map<string, CargoDependencyGraphNode>();
  const edges: CargoDependencyGraphEdge[] = [];

  for (const lp of resolvedPackages) {
    const id = makeNodeId(lp.name, lp.version, lp.source);
    nodesMap.set(id, {
      id,
      name: lp.name,
      version: lp.version,
      ...(lp.source ? { source: lp.source } : {}),
    });
  }

  for (const pkg of packages) {
    const id = makeNodeId(pkg.name, pkg.version);
    if (!nodesMap.has(id)) {
      nodesMap.set(id, { id, name: pkg.name, version: pkg.version });
    }
    for (const dep of pkg.dependencies) {
      let targetId = dep.package;
      if (resolvedPackages.length > 0) {
        const candidates = resolvedPackages.filter(
          (lp) => lp.name === dep.package,
        );
        const req =
          dep.source.type === "registry"
            ? dep.source.versionReq
            : dep.source.type === "path" || dep.source.type === "git"
              ? dep.source.versionReq
              : undefined;
        const matched =
          candidates.find((c) =>
            req ? satisfiesCargoReq(c.version, req) : true,
          ) ?? candidates[0];
        if (matched) {
          targetId = makeNodeId(matched.name, matched.version, matched.source);
        }
      }
      edges.push({
        from: id,
        to: targetId,
        kind: dep.kind,
        ...(dep.targetCondition
          ? { targetCondition: dep.targetCondition }
          : {}),
        optional: dep.optional,
        features: dep.features,
      });
    }
  }

  for (const lp of resolvedPackages) {
    const fromId = makeNodeId(lp.name, lp.version, lp.source);
    for (const depStr of lp.dependencies) {
      const parsed = parseLockDepString(depStr);
      let toId = parsed.name;
      const matched = resolvedPackages.find(
        (cand) =>
          cand.name === parsed.name &&
          (!parsed.version || cand.version === parsed.version) &&
          (!parsed.source || cand.source === parsed.source),
      );
      if (matched) {
        toId = makeNodeId(matched.name, matched.version, matched.source);
      } else if (parsed.version) {
        toId = makeNodeId(parsed.name, parsed.version, parsed.source);
        if (!nodesMap.has(toId)) {
          nodesMap.set(toId, {
            id: toId,
            name: parsed.name,
            version: parsed.version,
            ...(parsed.source ? { source: parsed.source } : {}),
          });
        }
      }
      edges.push({
        from: fromId,
        to: toId,
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
    ...(unreadableMembers.length > 0 ? { unreadableMembers } : {}),
    dependencyGraph: {
      nodes: Array.from(nodesMap.values()),
      edges,
    },
    diagnostics,
  });
};

const areDependenciesEqual = (
  a: CargoDeclaredDependency,
  b: CargoDeclaredDependency,
): boolean =>
  a.name === b.name &&
  a.package === b.package &&
  a.kind === b.kind &&
  a.targetCondition === b.targetCondition &&
  a.optional === b.optional &&
  a.defaultFeatures === b.defaultFeatures &&
  JSON.stringify(a.features) === JSON.stringify(b.features) &&
  JSON.stringify(a.source) === JSON.stringify(b.source);

const compareResolvedPackages = (
  beforeResolved: readonly CargoLockPackage[],
  afterResolved: readonly CargoLockPackage[],
): {
  addedResolvedPackages?: string[];
  removedResolvedPackages?: string[];
  changedResolvedPackages?: NonNullable<
    CargoManifestComparison["changedResolvedPackages"]
  >;
} => {
  if (beforeResolved.length === 0 && afterResolved.length === 0) {
    return {};
  }
  const beforeLockMap = new Map(beforeResolved.map((p) => [p.name, p]));
  const afterLockMap = new Map(afterResolved.map((p) => [p.name, p]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: NonNullable<
    CargoManifestComparison["changedResolvedPackages"]
  >[number][] = [];

  for (const [name, aPkg] of afterLockMap) {
    const bPkg = beforeLockMap.get(name);
    if (!bPkg) {
      added.push(name);
    } else if (bPkg.version !== aPkg.version || bPkg.source !== aPkg.source) {
      changed.push({
        name,
        beforeVersion: bPkg.version,
        afterVersion: aPkg.version,
        sourceChanged: bPkg.source !== aPkg.source,
        ...(bPkg.source !== undefined ? { beforeSource: bPkg.source } : {}),
        ...(aPkg.source !== undefined ? { afterSource: aPkg.source } : {}),
      });
    }
  }

  for (const name of beforeLockMap.keys()) {
    if (!afterLockMap.has(name)) {
      removed.push(name);
    }
  }

  return {
    ...(added.length > 0 ? { addedResolvedPackages: added } : {}),
    ...(removed.length > 0 ? { removedResolvedPackages: removed } : {}),
    ...(changed.length > 0 ? { changedResolvedPackages: changed } : {}),
  };
};

const compareSinglePackage = (
  name: string,
  pkgs: { before: CargoDeclaredPackage; after: CargoDeclaredPackage },
  resolved: {
    before: readonly CargoLockPackage[];
    after: readonly CargoLockPackage[];
  },
): CargoManifestComparison["changedPackages"][number] | undefined => {
  const bDepsMap = new Map<string, CargoDeclaredDependency>(
    pkgs.before.dependencies.map((d) => [d.name, d]),
  );
  const aDepsMap = new Map<string, CargoDeclaredDependency>(
    pkgs.after.dependencies.map((d) => [d.name, d]),
  );

  const addedDependencies: string[] = [];
  const removedDependencies: string[] = [];
  const changedDependencies: string[] = [];

  for (const [dName, aDep] of aDepsMap) {
    const bDep = bDepsMap.get(dName);
    if (!bDep) {
      addedDependencies.push(dName);
    } else if (!areDependenciesEqual(bDep, aDep)) {
      changedDependencies.push(dName);
    }
  }

  for (const dName of bDepsMap.keys()) {
    if (!aDepsMap.has(dName)) {
      removedDependencies.push(dName);
    }
  }

  const bLock = resolved.before.find((p) => p.name === name);
  const aLock = resolved.after.find((p) => p.name === name);
  const sourceChanged = bLock?.source !== aLock?.source;

  if (
    pkgs.before.version !== pkgs.after.version ||
    sourceChanged ||
    addedDependencies.length > 0 ||
    removedDependencies.length > 0 ||
    changedDependencies.length > 0
  ) {
    return {
      name,
      beforeVersion: pkgs.before.version,
      afterVersion: pkgs.after.version,
      sourceChanged,
      ...(bLock?.source !== undefined ? { beforeSource: bLock.source } : {}),
      ...(aLock?.source !== undefined ? { afterSource: aLock.source } : {}),
      addedDependencies,
      removedDependencies,
      ...(changedDependencies.length > 0 ? { changedDependencies } : {}),
    };
  }
  return undefined;
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

  const unreadableInAfter = new Set([
    ...(after.unreadableMembers ?? []),
    ...after.diagnostics
      .filter((d) => d.code === "unresolved_workspace_dependency")
      .map((d) => d.package),
  ]);

  for (const [name, bPkg] of beforePkgs) {
    const aPkg = afterPkgs.get(name);
    if (!aPkg) {
      if (
        Array.from(unreadableInAfter).some(
          (u) => u === name || u.includes(name) || name.includes(u),
        )
      ) {
        continue;
      }
      removedPackages.push(name);
      continue;
    }

    const changed = compareSinglePackage(
      name,
      { before: bPkg, after: aPkg },
      { before: before.resolvedPackages, after: after.resolvedPackages },
    );
    if (changed) {
      changedPackages.push(changed);
    }
  }

  const resolvedComp = compareResolvedPackages(
    before.resolvedPackages,
    after.resolvedPackages,
  );

  return {
    addedPackages,
    removedPackages,
    changedPackages,
    ...resolvedComp,
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
      packageMetadata: z
        .strictObject({
          version: z.string().optional(),
          edition: z.string().optional(),
          description: z.string().optional(),
          publish: z.union([z.boolean(), z.array(z.string())]).optional(),
          rustVersion: z.string().optional(),
        })
        .optional(),
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
      publish: z.union([z.boolean(), z.array(z.string())]).optional(),
      rustVersion: z.string().optional(),
      dependencies: z.array(cargoDeclaredDependencySchema),
      features: z.record(z.string(), z.array(z.string())),
      inheritedFromWorkspace: z
        .strictObject({
          version: z.boolean().optional(),
          edition: z.boolean().optional(),
          description: z.boolean().optional(),
          publish: z.boolean().optional(),
          rustVersion: z.boolean().optional(),
        })
        .optional(),
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
  unreadableMembers: z.array(z.string()).optional(),
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
        targetCondition: z.string().optional(),
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
        "invalid_lockfile_syntax",
        "feature_cycle",
      ]),
      message: z.string(),
      package: z.string(),
      dependency: z.string().optional(),
    }),
  ),
});
