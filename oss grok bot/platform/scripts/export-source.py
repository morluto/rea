import hashlib
import json
from pathlib import Path
import zipfile


root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
destination = root / ".local" / "releases" / f"Orbit Source {version}.zip"
roots = ["README.md", "package.json", "package-lock.json", ".gitignore", "apps", "packages", "computer", "device", "scripts", "test"]
excluded = {"node_modules", ".local", "__pycache__", "Pods", "DerivedData", "xcuserdata", ".DS_Store"}
excluded_roots = ["apps/desktop/release", "apps/mobile/www", "apps/mobile/ios/App/App/public"]
files = []
for source in roots:
    target = root / source
    candidates = [target] if target.is_file() else target.rglob("*")
    for path in candidates:
        relative = path.relative_to(root)
        if excluded.intersection(relative.parts):
            continue
        if any(relative.as_posix() == prefix or relative.as_posix().startswith(prefix + "/") for prefix in excluded_roots):
            continue
        if path.is_symlink():
            raise RuntimeError(f"Source export does not follow symlinks: {relative}")
        if path.is_file():
            files.append(relative)
destination.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for relative in sorted(files):
        archive.write(root / relative, relative.as_posix())
with zipfile.ZipFile(destination) as archive:
    if archive.testzip() is not None:
        raise RuntimeError("Source ZIP integrity check failed")
    exported = json.loads(archive.read("package.json"))
    if exported["version"] != version or len(archive.namelist()) != len(files):
        raise RuntimeError("Source ZIP manifest mismatch")
report = {
    "version": version,
    "path": str(destination),
    "files": len(files),
    "bytes": destination.stat().st_size,
    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    "runtimeDataIncluded": False,
    "appleBuildVerified": False,
}
verification = root / ".local" / "verification"
verification.mkdir(parents=True, exist_ok=True)
(verification / f"source-export-{version}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
