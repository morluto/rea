# Apktool resource decoding

REA decodes Android resource tables and the binary manifest through the
caller's Apktool launcher. This completes the static triad for Android
targets: Java/Kotlin sources through the JADX family, engine-grade
decompilation through JEB, and resources through this family. REA never
installs Apktool or a Java runtime.

## Supply tools

Use Apktool 2.7.0 or newer (verified with 2.7.0) and a Java runtime the
launcher can find. Select the launcher through the environment:

```sh
# Optional: absolute path to the apktool launcher (upstream wrapper or a
# java -jar script); without it, apktool resolves from PATH.
export REA_APKTOOL_COMMAND=/absolute/path/apktool
```

Readiness is `rea inspect-apktool-client`: it runs `apktool --version` and
reports the resolved launcher, its selection source, and its version. A
missing launcher reports `capability_unavailable` with the
`REA_APKTOOL_COMMAND` remediation rather than attempting an installation.

## Answer an analyst question

```sh
rea inspect-apktool-client
rea decode-android-resources /targets/Example.apk
rea decode-android-resources /targets/Example.apk --locale de
rea decode-android-resources /targets/Example.apk --no-strings
```

Equivalent MCP methods are `inspect_apktool_client` and
`decode_android_resources`. The decode request takes `path`, an optional
`locale` (project `res/values-<locale>/strings.xml` instead of the default
table), and `include_strings` (default true).

## Interpret the result

- **The target is digested before decoding.** `target.sha256` and
  `target.bytes` bind the observation to the exact APK that was decoded.
- **Metadata comes from apktool.yml as apktool printed it.** Version codes
  keep their own spelling (`'7'` versus `7`); `package_name` is read from
  the decoded manifest, not inferred.
- **The manifest is the decoded text**, bounded at 512 KiB and reported as
  truncated when larger.
- **Strings are projected verbatim.** Escaped entities stay escaped, and
  entries containing nested markup (`<b>`, `<xliff:g>`) are counted as
  unparsed rather than flattened — the limitation names the count. The
  default table is bounded to 2000 entries with partial coverage when more
  exist; `locales` lists every `values-<locale>` that has a strings table.
- **Smali is skipped by design** (`apktool d --no-src`): Java-source
  recovery belongs to the JADX family. Resource smali edits and rebuild are
  a follow-up lane with mutation authority.
- **Workspaces are owned and short-lived.** Decoding happens in a
  provider-owned temporary directory that is removed before the result is
  returned; if removal ever fails, the limitation names the residual path.

## Resource and lifecycle limits

- The decode runs with a 600 s deadline and a 4 MiB output capture budget;
  a stopped decode reports `provider_timeout` and exceeded budgets report
  `resource_constraint`.
- `decoded_file_count` is capped at 100,000 files; the cap is reported in
  the limitations when hit.
- Apktool's own decode failures (`AndrolibException`, directory traversal
  refusals) surface as `unsupported_target` with apktool's reason preserved
  verbatim.

## Real verification

`npm run verify:apktool -- --apk PATH` exercises both operations against a
real launcher. Record: apktool 2.7.0-dirty (Debian packaging) on Linux with
OpenJDK 25 against a signed aapt2-built probe APK carrying two resource
locales — launcher version, on-disk digest agreement, apktool.yml metadata
(1.2.3, SDK 24–34), manifest package agreement, default and `de` string
tables projected. Parser goldens in the test suite come from the same
decode. See `docs/testing.md` for the lane summary.
