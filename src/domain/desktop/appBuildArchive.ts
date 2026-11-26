/** The build runtime's archive layout, interpreted by both doctor and the offline installer. */
export const PYTHON_BUILD_ARCHIVE = String.raw`
import json
from pathlib import PurePosixPath


def inspect_rea_archive(archive, read_version=False):
    launchers, versions = {}, {}
    for entry in archive:
        parts = PurePosixPath(entry.name).parts
        if len(parts) == 3 and parts[1:] == ("scripts", "rea.mjs"):
            launchers[parts[0]] = entry
        elif read_version and len(parts) == 2 and parts[1] == "package.json":
            versions.pop(parts[0], None)
            if entry.isfile() and entry.size <= 1048576:
                with archive.extractfile(entry) as stream:
                    try:
                        version = json.load(stream).get("version")
                    except (ValueError, AttributeError):
                        continue
                if isinstance(version, str):
                    versions[parts[0]] = version

    # A hidden root never participated in the installer's original shell glob.
    visible = [root for root in launchers if not root.startswith(".")]
    if len(visible) != 1:
        observed_root = next(iter(launchers)) if len(launchers) == 1 else None
        return (None, versions.get(observed_root),
                "The REA archive must hold one visible top folder with scripts/rea.mjs.")

    root = visible[0]
    entry = launchers[root]
    if entry.isfile():
        return (PurePosixPath(root, "scripts", "rea.mjs"), versions.get(root), None)
    if entry.issym() or entry.islnk():
        try:
            stream = archive.extractfile(entry)
        except (KeyError, RecursionError):
            stream = None
        if stream is not None:
            stream.close()
            return (PurePosixPath(root, "scripts", "rea.mjs"), versions.get(root), None)
    return (None, versions.get(root),
            "scripts/rea.mjs must resolve to a regular file supplied by the archive.")
`;

export const PYTHON_BUILD_ARCHIVE_PROBE = `${PYTHON_BUILD_ARCHIVE}
import sys
import tarfile

with tarfile.open(sys.argv[1]) as archive:
    _, version, problem = inspect_rea_archive(archive, read_version=True)
print(json.dumps({"version": version, "problem": problem}))
`;
