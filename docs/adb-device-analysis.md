# ADB device inspection and acquisition

REA inspects connected Android devices, reads device state, and transfers
files and packages through the caller's `adb` binary. Emulators, USB
devices, and network devices participate alike: REA neither starts nor
manages them and never installs platform tools. Every operation composes a
fixed adb argument vector — caller values occupy positional arguments only
and never reach a shell.

The adb client may start its local server on first device query; that is adb
client behavior, recorded in the tool result when observed.
`inspect_adb_client` probes only the binary and never contacts the server.

## Supply tools

Use any Android platform-tools `adb` (verified with 34.0.5). Select it
through the environment:

```sh
# Optional: absolute path to the adb binary; without it, adb resolves from PATH.
export REA_ADB_PATH=/absolute/path/to/adb
```

REA never installs the Android SDK, an emulator, or a system image.
Readiness is `rea inspect-adb-client`: it runs `adb version` and reports the
resolved binary, its version, and where it was selected from. A missing
binary reports `capability_unavailable` with the `REA_ADB_PATH` remediation
rather than attempting an installation.

## Answer an analyst question

```sh
# Device identity
rea inspect-adb-client
rea list-adb-devices
rea inspect-adb-device emulator-5554
rea inspect-adb-display emulator-5554
rea list-adb-features emulator-5554
rea list-adb-services emulator-5554

# Find and acquire an app (the easy-get flow)
rea resolve-adb-packages emulator-5554 whatsapp
rea list-adb-packages emulator-5554 --scope third_party
rea inspect-adb-package emulator-5554 com.whatsapp
rea pull-adb-package emulator-5554 com.whatsapp --output-directory /tmp/acq
rea inspect-android-package /tmp/acq/com.whatsapp/base.apk

# Device state and files
rea list-adb-processes emulator-5554
rea inspect-adb-window emulator-5554
rea read-adb-setting emulator-5554 global adb_enabled
rea read-adb-logcat emulator-5554 --count 200
rea list-adb-directory emulator-5554 /data/data/com.whatsapp
rea pull-adb-file emulator-5554 /data/local/tmp/notes.txt --output-directory /tmp/acq
rea push-adb-file emulator-5554 /tools/frida-server /data/local/tmp/frida-server
rea capture-adb-screen emulator-5554 --output-directory /tmp/shots
rea collect-adb-bugreport emulator-5554 --output-directory /tmp/bugs

# Package lifecycle and dynamic analysis (device-mutating)
rea install-adb-package emulator-5554 /tmp/app.apk --replace
rea start-adb-app emulator-5554 com.example.app
rea read-adb-logcat emulator-5554 --pid 12345
rea start-adb-activity emulator-5554 android.intent.action.VIEW --data-uri https://example.com
rea stop-adb-app emulator-5554 com.example.app
rea uninstall-adb-package emulator-5554 com.example.app
```

Equivalent MCP methods use the snake_case names (`list_adb_devices`,
`pull_adb_package`, `resolve_adb_packages`, …). Device operations take
`serial` exactly as `adb devices` reports it. The pulled APK set feeds the
existing analysis families directly, for example
`rea inspect-android-package /tmp/acq/<package>/base.apk`.

## Operations

| Tool                    | Kind               | What it does                                                                                                                                                              |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_adb_client`    | read               | Resolved binary, version, install path; never contacts the server                                                                                                         |
| `list_adb_devices`      | read               | Serial, state, transport, model metadata, inferred emulator/physical kind with basis                                                                                      |
| `inspect_adb_device`    | read               | Fixed `getprop` whitelist: build, SDK, patch, fingerprint, product, ABIs, debuggable, `ro.kernel.qemu`                                                                    |
| `inspect_adb_display`   | read               | `wm size` and `wm density` as declared                                                                                                                                    |
| `list_adb_features`     | read               | `pm list features` (hardware/software features, hex GL versions)                                                                                                          |
| `list_adb_services`     | read               | `service list` binder services and interfaces                                                                                                                             |
| `list_adb_processes`    | read               | `ps -A`: user, pid, ppid, rss, state, name                                                                                                                                |
| `inspect_adb_window`    | read               | `dumpsys window` focus declarations (what is on screen)                                                                                                                   |
| `read_adb_setting`      | read               | One `settings get` value; device-side null is reported as such                                                                                                            |
| `read_adb_logcat`       | read               | Bounded `logcat -d -t` dump for one buffer, optional pid filter                                                                                                           |
| `list_adb_packages`     | read               | `pm list packages -f` with scope; base APK device paths                                                                                                                   |
| `resolve_adb_packages`  | read               | Case-insensitive package-name substring search with exact-match flag                                                                                                      |
| `inspect_adb_package`   | read               | `dumpsys package` projection: versions, install times, installer, flags, permission count                                                                                 |
| `list_adb_directory`    | read               | `ls -la`: kinds, permissions, owner, group, sizes, symlink targets                                                                                                        |
| `pull_adb_package`      | read               | Complete split APK set from `pm path`, each file digested                                                                                                                 |
| `pull_adb_file`         | read               | One absolute device path pulled and digested                                                                                                                              |
| `capture_adb_screen`    | read               | One `screencap -p` frame (exec-out, no device-side file) with dimensions                                                                                                  |
| `collect_adb_bugreport` | read               | Device-generated bugreport zip, digested                                                                                                                                  |
| `push_adb_file`         | **mutates device** | One local file to a device path (e.g. pushing tools into `/data/local/tmp`); refuses existing targets without explicit overwrite; verifies via the device's own sha256sum |
| `install_adb_package`   | **mutates device** | Local APK via `adb install [-r]`; preserves the device's Success/Failure verdict                                                                                          |
| `uninstall_adb_package` | **mutates device** | Removes a package and its data for user 0                                                                                                                                 |
| `start_adb_app`         | **mutates device** | Resolves the package's launcher activity (`cmd package resolve-activity --brief`) and starts it (`am start -n`)                                                           |
| `start_adb_activity`    | **mutates device** | Starts an intent (`am start -a` with optional URI, component, and up to 16 typed extras); preserves the activity manager's verdict                                        |
| `stop_adb_app`          | **mutates device** | Force-stops every process of a package, ending a dynamic-analysis run                                                                                                     |

## Interpret the result

- **Inferences carry their basis.** Device `kind` reports
  `kind_basis` (serial prefix or USB transport); APK `role` reports
  `role_basis: file_name`; `emulator_observed` is the build's own
  `ro.kernel.qemu` value, `null` when absent.
- **Device paths are not host paths.** `base_apk_device_path` values live on
  the device filesystem. Only pulls and captures produce host-local paths,
  each paired with byte size and SHA-256 digest.
- **Splits are part of the answer.** `pm path` enumerates the base APK and
  every installed split; pulls cover the whole set. System packages whose
  APKs keep other names report the `unknown` role rather than guessing.
- **Partial results keep facts.** Failed individual pulls return successful
  artifacts with `coverage: "partial"` and per-file `failures`. Listings
  that contain unrecognized lines report them as `unparsed_lines` and mark
  partial coverage instead of dropping rows.
- **Mutations are explicit.** `push_adb_file`, `install_adb_package`, and
  `uninstall_adb_package` declare `mutatesTarget` and never run implicitly:
  pushes refuse existing device files unless `overwrite` is set and verify
  the transfer with the device's own `sha256sum`; installs preserve the
  device's `Failure [...]` reason verbatim.
- **Producer identity stays attached.** Every result embeds the producing
  adb client (`binary_path`, `path_source`, `version`, `installed_path`).

## Resource and lifecycle limits

- Caller values reach adb only as positional arguments in fixed vectors;
  no tool accepts an arbitrary shell command line, and UI interaction
  (`input`, `am`, `monkey`) is deliberately not exposed.
- Per-invocation budgets: client/devices 10-20 s, shell reads 20-60 s with
  64 KiB-8 MiB capture caps (logcat 4 MiB, screen 32 MiB), transfers and
  bugreports 600 s. Exceeded budgets report `resource_constraint`; stopped
  commands report `provider_timeout`.
- Pull and capture outputs are additive: the destination must not already
  exist. Re-running a completed pull refuses the existing directory instead
  of overwriting evidence.
- The provider holds no long-lived processes; every invocation is one
  bounded adb run. The adb server belongs to the caller.

## Related capability and follow-up lanes

UI interaction beyond intent starts (tapping, typing, monkey fuzzing, screen
recording) remains a separate lane: candidates such as
[mobile-device-mcp](https://github.com/srmorete/mobile-device-mcp) install
driver software on the device and pair with the Frida instrumentation lane
(#1359) behind explicit mutation-authority contracts. Network transports
beyond already-connected devices (`adb connect`) are not exposed yet.

## Real verification

`npm run verify:adb` exercises every operation against a live device. It
requires `adb` (or `REA_ADB_PATH`) and any attached emulator or phone;
`--serial` selects one when several are attached, `--pull PACKAGE` pulls a
real package and verifies the returned digests against the files on disk,
and `--install-apk PATH` drives a full install → resolve → uninstall
lifecycle with a lane-owned probe.

Record: verified against adb 34.0.5 on Linux against an Android 14
(API 34) x86_64 emulator — all operations above, a 224-package inventory,
287 services, 92 features, a real two-APK split set pulled with byte-exact
digests, a verified push/pull roundtrip, a 1.3 MB screen capture, and the
complete package lifecycle; see `docs/testing.md` for the lane summary.
