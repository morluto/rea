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
  // overrides. Preserve development security overrides in the source owner.
  // Runtime overrides cannot disappear with the development tree, so pin the
  // published shrinkwrap's runtime parent ranges to the exact locked version.
  // Reject overrides that cannot be represented exactly.
  const runtimeOverrides = new Map();
  for (const [name, override] of Object.entries(manifest.overrides ?? {})) {
    const matches = Object.entries(lock.packages).filter(([path]) =>
      path.endsWith(`node_modules/${name}`),
    );
    if (matches.length === 0)
      throw new Error(`Cannot omit a runtime or unresolved override: ${name}`);
    const runtime = matches.filter(([, entry]) => entry.dev !== true);
    if (runtime.length === 0) continue;
    if (
      typeof override !== "string" ||
      manifest.dependencies?.[name] !== undefined ||
      runtime.some(([, entry]) => entry.version !== override)
    )
      throw new Error(`Cannot omit a runtime or unresolved override: ${name}`);
    runtimeOverrides.set(name, override);
  }

  const rewriteRuntimeEdges = (entry) => {
    let copy = entry;
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = entry[field];
      if (dependencies === undefined) continue;
      let rewritten;
      for (const [name, version] of runtimeOverrides) {
        if (
          dependencies[name] !== undefined &&
          dependencies[name] !== version
        ) {
          rewritten ??= { ...dependencies };
          rewritten[name] = version;
        }
      }
      if (rewritten !== undefined) copy = { ...copy, [field]: rewritten };
    }
    return copy;
  };

  const packageJson = { ...manifest };
  delete packageJson.devDependencies;
  delete packageJson.overrides;
  // Codex's npm source fetches the archive without installing dependencies.
  // Keep optional Frida outside the bundle so ordinary npm installs can still
  // run its host-specific installer. PTY binaries are transitive optionals of
  // a runtime dependency and are included for every supported platform by the
  // archive producer.
  packageJson.bundleDependencies = Object.keys(manifest.dependencies ?? {});
  const root = rewriteRuntimeEdges({ ...lock.packages[""] });
  delete root.devDependencies;
  const shrinkwrap = {
    ...lock,
    packages: Object.fromEntries(
      Object.entries(lock.packages)
        .filter(([, entry]) => entry.dev !== true)
        .map(([path, entry]) => [path, rewriteRuntimeEdges(entry)]),
    ),
  };
  shrinkwrap.packages[""] = root;
  return { packageJson, shrinkwrap };
}
