# Apple Application Inventory Projection

REA can project one or more authenticated `inventory_artifact` Evidence records
for the same IPA, macOS `.app` directory, ZIP, or DMG into an Apple application
inventory. The projection is execution-free: it reports exact paths, content
hashes, detected formats, bundle anatomy, runtime-family hints, and path-based
bridge hypotheses. It does not parse plist or CMS semantics or claim observed
runtime calls.

```sh
rea project-apple-application-graph '{"inventory_evidence":[<inventory_artifact Evidence>]}'
```

```json
{
  "name": "project_apple_application_graph",
  "arguments": {
    "inventory_evidence": ["<inventory_artifact Evidence>"]
  }
}
```

The result includes every component in each inventory category and every
JavaScript-to-native bridge candidate pair. It has no caller-selected component
budget, prefix truncation, or omitted-count fields. Duplicate inventory pages
are merged by artifact identity and occurrence path; their Evidence IDs remain
attached as source Evidence.

Coverage is `complete-within-inventory` when the supplied pages reconstruct the
complete authenticated inventory, and `partial` otherwise. A partial result
states that absence is unknown. Component and bridge-candidate arrays are still
the complete projection of the inventory that was supplied.

## Application roots

| Inventory root                         | Application root                                    |
| -------------------------------------- | --------------------------------------------------- |
| IPA                                    | Each `Payload/<Name>.app`                           |
| `.app` directory                       | `.`, the inventoried bundle itself                  |
| Directory, ZIP, or DMG containing apps | Each outermost `<Name>.app` followed by `Contents/` |

ZIP archives made with `ditto -c -k --keepParent` report `<Name>.app`. A DMG
reports `<image>.dmg/<Volume>/<Name>.app`; DMG child inventory needs the native
macOS mounting adapter. When a DMG has only its root identity, the projection is
`partial` and says that bundle absence is unknown. Other inventory formats, such
as APK or ASAR, are rejected as input errors.

An inventoried directory whose name ends in `.app` is its own root even when its
inventory is partial or lacks `Contents/`. For directory, ZIP, and DMG
inventories, components outside every application root are not attributed to
the application. This covers installers, disk-image extras, and AppleDouble
sidecars, which therefore stay out of runtime families and bridge candidates. A
limitation reports how many inventoried entries were left out. IPA projection
still lists every archive component, including `SwiftSupport/`.

`platforms` lists `macos` for application roots with `Contents/`. It lists `ios`
for shallow application roots that have an `Info.plist`. An application root
with neither, such as an empty inventory, has no platform.

## macOS bundle anatomy

`bundles` lists each application root and every nested bundle under it. Each
bundle reports its `parent_path`, `layout`, `info_plist_path`,
`executable_candidates`, and `signing_paths`.

| Layout                | Meaning         | Content directory                             |
| --------------------- | --------------- | --------------------------------------------- |
| `macos-deep`          | Has `Contents/` | `Contents/`, executables in `Contents/MacOS/` |
| `versioned-framework` | Has `Versions/` | Each real `Versions/<version>/`               |
| `shallow`             | Neither         | The bundle directory itself                   |

Roles are path conventions (`role_basis: "path-convention"`):

| Role                 | Path                                                            |
| -------------------- | --------------------------------------------------------------- |
| `app-extension`      | `*.appex`                                                       |
| `xpc-service`        | `*.xpc`, including XPC services inside frameworks               |
| `framework`          | `*.framework`                                                   |
| `system-extension`   | `*.systemextension`                                             |
| `driver-extension`   | `*.dext`                                                        |
| `plug-in`            | `PlugIns/*.bundle`, `*.plugin`, `*.qlgenerator`, `*.mdimporter` |
| `resource-bundle`    | `Resources/*.bundle`, such as SwiftPM resource bundles          |
| `bundle`             | Any other `*.bundle`                                            |
| `login-item`         | `Contents/Library/LoginItems/*.app`                             |
| `helper-application` | `Contents/Helpers/*.app`                                        |
| `nested-application` | Any other nested `*.app`                                        |

The components also list:

- `privileged_helpers`: files directly in `Contents/Library/LaunchServices/`,
  where SMJobBless helpers live;
- `launchd_plists`: `.plist` files directly in `Contents/Library/LaunchAgents/`
  (`domain: "agent"`) or `Contents/Library/LaunchDaemons/` (`domain: "daemon"`),
  as used by SMAppService;
- `helpers`: files directly in `Contents/Helpers/`.

Symlinks are reported by path in `symlinks`. Their targets are not inventoried,
so a versioned framework is described through its real `Versions/<version>/`
directories rather than `Versions/Current`. When a framework has zero or several
`Versions/*/Resources/Info.plist` files, its `info_plist_path` is `null` and a
limitation explains why.

AppleDouble sidecar files (`._*` and `__MACOSX/`) are inventory facts, but they
describe neighbouring files. They are excluded from roots, bundle roles, and the
anatomy components.

The projection does not read plists. Use `inspect_plist` on a bundle's
`info_plist_path` or a launchd plist to read `CFBundleExecutable`, identifiers,
`SMPrivilegedExecutables`, `BundleProgram`, URL schemes, and usage descriptions.
Use `inspect_signature` on an executable candidate for code-signing claims.
