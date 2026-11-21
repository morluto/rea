import { verifyPublishedPackageIntegrity } from "./qualified-package-envelope.mjs";

const registry = "https://registry.npmjs.org";
const packageName = "rea-agents";

function readRegistry(request, path, accept = "application/json") {
  return request(`${registry}/${path}`, {
    headers: { Accept: accept, "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
}

/** Parse fresh registry state using the channel already owned by qualification. */
export async function readQualifiedNpmRelease(version, tag, request = fetch) {
  if (!["latest", "next"].includes(tag))
    throw new Error("Invalid qualified npm channel");
  const response = await readRegistry(
    request,
    packageName,
    "application/vnd.npm.install-v1+json",
  );
  if (response.status !== 404) {
    if (!response.ok)
      throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
    const metadata = requireRecord(await response.json());
    if (metadata.name !== packageName)
      throw new Error("Unexpected npm package name");
    const versions = requireRecord(metadata.versions);
    const tags = requireTags(metadata["dist-tags"]);
    if (Object.hasOwn(versions, version))
      return publishedState(
        version,
        tag,
        requireRecord(versions[version]),
        tags,
      );
  }

  // The cacheable package index can omit a version that the registry serves
  // directly. Confirm absence independently before authorizing publication.
  const exact = await readRegistry(
    request,
    `${packageName}/${encodeURIComponent(version)}`,
  );
  if (exact.status === 404) return { status: "absent" };
  if (!exact.ok)
    throw new Error(`npm version lookup failed: HTTP ${exact.status}`);
  const published = requireRecord(await exact.json());
  const tags = await readRegistry(
    request,
    `-/package/${packageName}/dist-tags`,
  );
  if (!tags.ok)
    throw new Error(`npm dist-tag lookup failed: HTTP ${tags.status}`);
  return publishedState(
    version,
    tag,
    published,
    requireTags(await tags.json()),
  );
}

function requireTags(value) {
  const tags = requireRecord(value);
  if (Object.values(tags).some((value) => typeof value !== "string"))
    throw new Error("Invalid npm dist-tags");
  return tags;
}

function publishedState(version, tag, published, tags) {
  const dist = requireRecord(published.dist);
  if (
    published.name !== packageName ||
    published.version !== version ||
    typeof dist.integrity !== "string" ||
    dist.integrity.length === 0
  )
    throw new Error("Invalid published npm identity or integrity");
  return {
    status: "published",
    integrity: dist.integrity,
    tag,
    taggedVersion: tags[tag] ?? null,
    stableVersion: tags.latest ?? null,
  };
}

function requireRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid npm registry metadata");
  return value;
}

/** Validate content before accepting a previously published or newly visible version. */
export async function requireMatchingNpmRelease(tarball, version, published) {
  if (published.status !== "published")
    throw new Error(`rea-agents@${version} is not published`);
  await verifyPublishedPackageIntegrity(tarball, published.integrity);
  if (published.taggedVersion !== version)
    throw new Error(
      `Expected npm ${published.tag} to select ${version}, observed ${published.taggedVersion ?? "missing"}; refusing to change an existing dist-tag`,
    );
}
