/** Project the development manifest and lock into the shared runtime artifact. */
export function pluginPackageMetadata(manifest, lock) {
  if (
    lock.lockfileVersion !== 3 ||
    lock.name !== manifest.name ||
    lock.version !== manifest.version ||
    lock.packages?.[""]?.version !== manifest.version
  )
    throw new Error("Plugin packaging requires the matching v3 package lock");

  // Claude skips dependency installation when a published manifest has
  // overrides. Preserve development security overrides in the source owner,
  // and reject any future runtime override rather than silently discarding it.
  for (const name of Object.keys(manifest.overrides ?? {})) {
    const matches = Object.entries(lock.packages).filter(([path]) =>
      path.endsWith(`node_modules/${name}`),
    );
    if (matches.length === 0 || matches.some(([, entry]) => entry.dev !== true))
      throw new Error(`Cannot omit a runtime or unresolved override: ${name}`);
  }

  const packageJson = { ...manifest };
  delete packageJson.devDependencies;
  delete packageJson.overrides;
  // Codex's npm source fetches the archive without installing dependencies.
  // Keep optional Frida outside the bundle so ordinary npm installs can still
  // run its host-specific installer. Native platform binaries are transitive
  // optionals of runtime dependencies; the archive producer adds every
  // supported platform's copy (see pluginPlatformPackages).
  packageJson.bundleDependencies = Object.keys(manifest.dependencies ?? {});
  const root = { ...lock.packages[""] };
  delete root.devDependencies;
  const shrinkwrap = {
    ...lock,
    packages: Object.fromEntries(
      Object.entries(lock.packages).filter(([, entry]) => entry.dev !== true),
    ),
  };
  shrinkwrap.packages[""] = root;
  return { packageJson, shrinkwrap };
}

// Hosts a plugin archive must run on. npm ci on the producing host filters
// other platforms' optional binaries, so these are restored explicitly.
const PLUGIN_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const PLUGIN_ARCHITECTURES = new Set(["arm64", "x64"]);

const supportsPluginHost = (entry) =>
  (entry.os ?? []).some((os) => PLUGIN_PLATFORMS.has(os)) &&
  (entry.cpu ?? []).some((cpu) => PLUGIN_ARCHITECTURES.has(cpu));

/** Resolve a dependency from a lock path the way Node walks node_modules. */
const resolveLockedDependency = (packages, parentPath, name) => {
  let base = parentPath;
  for (;;) {
    const candidate = `${base === "" ? "" : `${base}/`}node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (base === "") return undefined;
    const index = base.lastIndexOf("/node_modules/");
    base = index === -1 ? "" : base.slice(0, index);
  }
};

/**
 * List the platform-specific optional packages of the runtime tree that a
 * supported plugin host needs, at the lock path npm would install them.
 */
export function pluginPlatformPackages(shrinkwrap) {
  const packages = shrinkwrap.packages;
  const required = new Map();
  for (const [parentPath, parent] of Object.entries(packages)) {
    if (parentPath === "" || parent.dev === true) continue;
    for (const name of Object.keys(parent.optionalDependencies ?? {})) {
      const path = resolveLockedDependency(packages, parentPath, name);
      const locked = path === undefined ? undefined : packages[path];
      if (locked === undefined) {
        // An unlocked optional that names a platform family member cannot be
        // judged, so refuse rather than ship an archive missing a host binary.
        throw new Error(`Plugin platform dependency is not locked: ${name}`);
      }
      if (locked.os === undefined && locked.cpu === undefined) continue;
      if (!supportsPluginHost(locked)) continue;
      if (locked.version === undefined || locked.integrity === undefined)
        throw new Error(`Plugin platform dependency is not locked: ${name}`);
      required.set(path, {
        name,
        path,
        version: locked.version,
        integrity: locked.integrity,
      });
    }
  }
  return [...required.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
