import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdbDeviceAnalysisService } from "../dist/application/adb/AdbDeviceAnalysisService.js";
import { createAdbDeviceAnalysisProvider } from "../dist/composition/adb.js";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(
    "Usage: npm run verify:adb [-- --serial SERIAL --pull PACKAGE]\n" +
      "Requires a caller-selected adb binary (REA_ADB_PATH or PATH) and a\n" +
      "connected device or emulator. Verifies all five operations against\n" +
      "the live device; --pull acquires a real package and re-digests the\n" +
      "files on disk against the returned SHA-256 values.\n",
  );
  process.exit(0);
}

const provider = createAdbDeviceAnalysisProvider(process.env);
const service = new AdbDeviceAnalysisService(provider);
let failures = 0;
const check = (name, condition, detail = "") => {
  const mark = condition ? "ok" : "FAIL";
  process.stdout.write(
    `[${mark}] ${name}${detail === "" ? "" : ` — ${detail}`}\n`,
  );
  if (!condition) failures += 1;
};

const run = async (operation, input) => {
  const result = await service.execute(operation, input);
  if (!result.ok) {
    process.stdout.write(`[FAIL] ${operation} — ${result.error.message}\n`);
    failures += 1;
    return null;
  }
  return result.value.normalized_result;
};

const client = await run("inspect_adb_client", {});
if (client !== null) {
  check(
    "adb client reports a version",
    typeof client.client.version === "string" && client.client.version !== "",
    `binary=${client.client.binary_path} version=${client.client.version}`,
  );
}

const listing = await run("list_adb_devices", {});
let serial = options.serial ?? null;
if (listing !== null) {
  check(
    "device listing parsed",
    Array.isArray(listing.devices),
    `${listing.devices.length} device(s)`,
  );
  const usable = listing.devices.filter((device) => device.state === "device");
  if (serial === null && usable.length > 0) serial = usable[0].serial;
  if (serial === null) {
    process.stdout.write(
      "[FAIL] no usable device is attached; start an emulator or connect a phone\n",
    );
    failures += 1;
  } else {
    const selected = listing.devices.find((device) => device.serial === serial);
    check(
      "selected device present with a kind inference",
      selected !== undefined &&
        ["emulator", "physical", "unknown"].includes(selected.kind),
      `serial=${serial} kind=${selected?.kind} basis=${selected?.kind_basis}`,
    );
  }
}

if (serial !== null) {
  const device = await run("inspect_adb_device", { serial });
  if (device !== null) {
    check(
      "device build identity projected",
      device.properties.some(
        (property) => property.name === "ro.build.version.sdk",
      ),
      `sdk=${
        device.properties.find((p) => p.name === "ro.build.version.sdk")?.value
      } emulator_observed=${String(device.emulator_observed)}`,
    );
  }

  const packages = await run("list_adb_packages", {
    serial,
    scope: "third_party",
  });
  let pullCandidate = options.pull ?? null;
  if (packages !== null) {
    // A third-party scope may legitimately be empty (clean emulator images);
    // completeness is about unparsed lines, not row count.
    check(
      "third-party package listing reports complete coverage",
      packages.coverage === "complete",
      `${packages.packages.length} package(s)`,
    );
    const allPackages = await run("list_adb_packages", {
      serial,
      scope: "all",
    });
    if (allPackages !== null) {
      check(
        "full package inventory is non-empty",
        allPackages.coverage === "complete" && allPackages.packages.length > 0,
        `${allPackages.packages.length} package(s)`,
      );
    }
    if (pullCandidate === null && packages.packages.length > 0)
      pullCandidate = packages.packages[0].package_name;
  }

  if (pullCandidate !== null) {
    const directory = await mkdtemp(join(tmpdir(), "rea-adb-verify-"));
    try {
      const pull = await run("pull_adb_package", {
        serial,
        package: pullCandidate,
        output_directory: directory,
      });
      if (pull !== null) {
        // Installed /data/app packages name their APKs base.apk and
        // split_*.apk; system packages keep arbitrary names, so the lane
        // checks a non-empty artifact set and verifies each file on disk.
        check(
          "pull returned a non-empty artifact set",
          pull.artifacts.length > 0,
          `${pull.artifacts.length} artifact(s), coverage=${pull.coverage}, roles=${pull.artifacts.map((a) => a.role).join(",")}`,
        );
        for (const artifact of pull.artifacts) {
          const bytes = await stat(artifact.local_path).then(
            (info) => info.size,
          );
          const digest = createHash("sha256")
            .update(await readFile(artifact.local_path))
            .digest("hex");
          check(
            `artifact digest matches on disk: ${artifact.file_name}`,
            bytes === artifact.bytes && digest === artifact.sha256,
            `${bytes} bytes`,
          );
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

try {
  await provider.close();
} catch {
  // The provider owns nothing long-lived; closing is best-effort.
}

if (failures > 0) {
  process.stdout.write(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall adb device checks passed\n");

function parseArguments(argv) {
  const parsed = { help: false, serial: null, pull: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--serial") {
      parsed.serial = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--pull") {
      parsed.pull = argv[index + 1] ?? null;
      index += 1;
    } else {
      process.stderr.write(`unknown argument: ${argument}\n`);
      process.exit(2);
    }
  }
  return parsed;
}
