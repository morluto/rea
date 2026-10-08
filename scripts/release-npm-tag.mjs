import semver from "semver";

const version = process.argv[2];
if (version === undefined || semver.valid(version) !== version) {
  console.error("Expected an exact SemVer version.");
  process.exitCode = 1;
} else {
  process.stdout.write(semver.prerelease(version) === null ? "latest" : "next");
}
