# ADB device inspection and acquisition

REA inspects connected Android devices and acquires installed APK sets
through the caller's `adb` binary. Emulators, USB devices, and network
devices participate alike: REA neither starts nor manages them, never
installs platform tools, and never mutates the device. The only filesystem
writes are the caller-requested APK pulls, into a package-named directory
that must not already exist.

The adb client may start its local server on first device query; that is adb
client behavior, recorded in the tool result when observed. `inspect_adb_client`
probes only the binary and never contacts the server.

## Supply tools

Use any Android platform-tools `adb` (verified with 34.0.5). Select it through
the environment:

```sh
# Optional: absolute path to the adb binary; without it, adb resolves from PATH.
export REA_ADB_PATH=/absolute/path/to/adb
```

REA never installs the Android SDK, an emulator, or a system image. Readiness
is `rea inspect-adb-client`: it runs `adb version` and reports the resolved
binary, its version, and where it was selected from. A missing binary reports
`capability_unavailable` with the `REA_ADB_PATH` remediation rather than
attempting an installation.

## Answer an analyst question

```sh
rea inspect-adb-client
rea list-adb-devices
rea inspect-adb-device emulator-5554
rea list-adb-packages emulator-5554 --scope third_party
rea pull-adb-package emulator-5554 org.thoughtcrime.securesms --output-directory /tmp/acq
```

Equivalent MCP methods are `inspect_adb_client`, `list_adb_devices`,
`inspect_adb_device`, `list_adb_packages`, and `pull_adb_package`. Device
operations take `serial` exactly as `adb devices` reports it; package listing
takes an optional `scope` of `all` (default), `third_party`, or `system`;
pull takes `package` and `output_directory`.

The pulled APK set feeds the existing analysis families directly, for example
`rea inspect-android-package /tmp/acq/<package>/base.apk`.

## Interpret the result

- **Device kind is inferred, not attested.** `list_adb_devices` reports
  `kind` (`emulator`, `physical`, `unknown`) with `kind_basis` naming the
  evidence used: the `emulator-<port>` serial convention or USB transport
  metadata. `inspect_adb_device` can upgrade this to an observation through
  the fixed `getprop` whitelist, where `ro.kernel.qemu` reports the build's
  own emulator indicator (`emulator_observed`: `true`, `false`, or `null`
  when the property is absent).
- **Device paths are not host paths.** `base_apk_device_path` values live on
  the device filesystem. Only `pull_adb_package` produces host-local paths,
  each paired with its device origin, byte size, and SHA-256 digest.
- **Splits are part of the answer.** `pm path` enumerates the base APK and
  every installed split; pulls cover the whole set. `role` (`base`, `split`,
  `unknown`) is derived from the file name and `role_basis` records that.
- **Partial pulls keep facts.** When individual pulls fail, successful
  artifacts return with `coverage: "partial"` and per-file `failures`
  carrying the stage (`resolve_paths`, `pull`, `digest`) and adb's reason.
  A pull that fails entirely leaves no package directory behind and reports
  the first failure reason.
- **Unrecognized output is preserved.** Package listings that contain lines
  REA cannot parse report them as `unparsed_lines` and mark
  `coverage: "partial"` instead of silently dropping rows.

Every tool result records which adb binary produced it (`binary_path`,
`path_source`, `version`, `installed_path`) so Evidence keeps producer
provenance alongside the observation.

## Resource and lifecycle limits

- Caller values reach adb only as positional arguments in fixed vectors;
  no tool accepts an arbitrary shell command line.
- Per-invocation budgets: client/devices 10-20 s, shell `getprop` and
  `pm` queries 30-60 s with 64 KiB-8 MiB capture caps, each `adb pull`
  600 s. Exceeded capture budgets report `resource_constraint`; hung
  commands are stopped and reported as `provider_timeout`.
- Pull outputs are additive: REA creates the caller's output directory if
  absent, then one package-named subdirectory that must not already exist.
  Re-running a completed pull refuses the existing directory instead of
  overwriting evidence.
- The provider holds no long-lived processes; every invocation is one
  bounded adb run. The adb server belongs to the caller.

## Related capability and follow-up lanes

Device _interaction_ (tapping, screenshots, UI-tree capture, app install)
is a different lane with different authority: candidates such as
[mobile-device-mcp](https://github.com/srmorete/mobile-device-mcp) install
driver software on the device, so they belong behind explicit
mutation-authority contracts rather than this read-only family, and pair
with the Frida instrumentation lane (#1359) rather than acquisition.
Network transports beyond already-connected devices (`adb connect`) are not
exposed yet.

## Real verification

`npm run verify:adb` exercises the five operations against a live device.
It requires `adb` (or `REA_ADB_PATH`) and any attached emulator or phone;
`--serial` selects one when several are attached, and `--pull PACKAGE`
optionally pulls a real package into a temporary directory and verifies the
returned digests against the files on disk.

Record: verified against adb 34.0.5 on Linux against an Android 14
(API 34) x86_64 emulator — all five operations, a 224-package inventory, and
a real two-APK split set pulled with byte-exact digests; see
`docs/testing.md` for the lane summary.
