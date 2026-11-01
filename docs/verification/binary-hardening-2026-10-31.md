# Binary hardening verification - 2026-10-31

Command: `npm run verify:binary-hardening`

`package.json` maps that script to `node scripts/verify-binary-hardening.mjs`.
The script loads its TypeScript sources with `importVerifierSource`. Its stderr
printed `ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time`.
The process exited 0. No target was executed. `readelf` was not present, so
this run did not compare ELF rows with readelf output.

Host from the script JSON: `darwin arm64`. `node` was `v24.22.1`. The script's
`npm -v` line was `11.16.0`.

## Tools the script found

`xcrun --find` from the script:

| Name           | Status | Path                                                                                           |
| -------------- | -----: | ---------------------------------------------------------------------------------------------- |
| `readelf`      |     72 | none                                                                                           |
| `llvm-readelf` |     72 | none                                                                                           |
| `clang`        |      0 | `/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang` |
| `gcc`          |      0 | `/Applications/Xcode.app/Contents/Developer/usr/bin/gcc`                                       |
| `cc`           |      0 | `/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/cc`    |
| `ld`           |      0 | `/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/ld`    |

The stored `readelf` stderr was `xcrun: error: sh -c '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -sdk /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk -find readelf 2> /dev/null' failed with exit code 17664: `.
The stored `llvm-readelf` stderr was `xcrun: error: sh -c '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -sdk /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk -find llvm-readelf 2> /dev/null' failed with exit code 17`.
The script keeps 240 characters of that stderr.

Compilers selected, with the version line the script ran:

| Name               | Command                 | Version line                                      |
| ------------------ | ----------------------- | ------------------------------------------------- |
| `gcc`              | `/usr/bin/gcc`          | `Apple clang version 21.0.0 (clang-2100.1.1.101)` |
| `clang-linux-gnu`  | `/usr/bin/clang`        | `Apple clang version 21.0.0 (clang-2100.1.1.101)` |
| `clang-linux-musl` | `/usr/bin/clang`        | `Apple clang version 21.0.0 (clang-2100.1.1.101)` |
| `zig-linux-gnu`    | `/opt/homebrew/bin/zig` | `0.16.0`                                          |
| `zig-linux-musl`   | `/opt/homebrew/bin/zig` | `0.16.0`                                          |

`x86_64-linux-gnu-gcc`, `aarch64-linux-gnu-gcc`, and `musl-gcc` were not in
that list. The script recorded `elf-readelf`: `No readelf or llvm-readelf was found. Compiled ELF images are still parsed.`

For each variant the script tries later compilers when an earlier one does not
emit the requested ELF feature. It stops that variant at the first ELF whose
parsed rows meet the feature. `execstack` needs NX `disabled`. `stack-protector`
needs `stack_protector` `enabled`. Other variants accept the first ELF. A
missing feature is recorded and does not fail the process. A present `readelf`
that disagrees still fails the process. This run had no `readelf`.

`DT_NEEDED` and build-id below are the script's own little-endian ELF reads,
because `readelf` was absent.

## Synthetic PE

`peHardeningImage()` built a PE32+ fixture. `readPeHardening` reported bits 64
and these states:

| Property               | State    |
| ---------------------- | -------- |
| `dynamic_base`         | enabled  |
| `high_entropy_va`      | enabled  |
| `nx_compat`            | enabled  |
| `force_integrity`      | disabled |
| `no_seh`               | disabled |
| `guard_cf`             | enabled  |
| `cfg_instrumented`     | enabled  |
| `authenticode_present` | disabled |
| `debug_record_present` | disabled |

## ELF

`/usr/bin/gcc` compiled `pie`, `no-pie`, `stack-protector`, `dynamic`, and
`two-needed`, and the script skipped each with `compiler did not emit ELF`.
The same compiler exited 1 for `relro-now`, `relro`, `no-relro`, `execstack`,
and `build-id`. Those stderrs named unused `-pie` and `ld: unknown options`
for `-z` or `--build-id=sha1`.

`/usr/bin/clang --target=x86_64-linux-gnu` and
`/usr/bin/clang --target=x86_64-linux-musl` exited 1 for every variant. The
`pie` stderr was `ld: unknown options: --hash-style=gnu --eh-frame-hdr -dynamic-linker --as-needed --no-as-needed --as-needed --no-as-needed` and
`clang: error: linker command failed with exit code 1 (use -v to see invocation)`.

`zig cc -target x86_64-linux-gnu` emitted an ELF for every variant except
`execstack`. The script stopped those variants there, except `stack-protector`,
where `stack_protector` stayed `unknown`, so it also parsed
`zig cc -target x86_64-linux-musl`.

| Variant           | Compiler       |   Bytes | `DT_NEEDED` | Build-id | PIE      | NX      | RELRO    | Stack protector | Stripped | CET      |
| ----------------- | -------------- | ------: | ----------: | -------- | -------- | ------- | -------- | --------------- | -------- | -------- |
| `pie`             | zig-linux-gnu  | 3792792 |           3 | no       | enabled  | enabled | enabled  | unknown         | disabled | disabled |
| `no-pie`          | zig-linux-gnu  | 3788400 |           3 | no       | disabled | enabled | enabled  | unknown         | disabled | disabled |
| `relro-now`       | zig-linux-gnu  | 3792792 |           3 | no       | enabled  | enabled | enabled  | unknown         | disabled | disabled |
| `relro`           | zig-linux-gnu  | 3792768 |           3 | no       | enabled  | enabled | partial  | unknown         | disabled | disabled |
| `no-relro`        | zig-linux-gnu  | 3792600 |           3 | no       | enabled  | enabled | disabled | unknown         | disabled | disabled |
| `stack-protector` | zig-linux-gnu  | 3792792 |           3 | no       | enabled  | enabled | enabled  | unknown         | disabled | disabled |
| `stack-protector` | zig-linux-musl | 4476552 |           0 | no       | enabled  | enabled | enabled  | unknown         | disabled | disabled |
| `build-id`        | zig-linux-gnu  | 3792912 |           3 | yes      | enabled  | enabled | enabled  | unknown         | disabled | disabled |
| `dynamic`         | zig-linux-gnu  | 3792792 |           3 | no       | enabled  | enabled | enabled  | unknown         | disabled | disabled |
| `two-needed`      | zig-linux-gnu  | 3792952 |           5 | no       | enabled  | enabled | enabled  | unknown         | disabled | disabled |

`build-id` note alignments recorded by the script were `4:32` and `4:36`.
`cet_ibt_shstk` on that image was `disabled`.

`stack-protector` was recorded unavailable: `No compiler emitted an ELF with an undefined dynamic __stack_chk_fail, so stack_protector enabled was not observed.`

`execstack` (`-Wl,-z,execstack`) produced no ELF. Both zig targets exited 1
with `error: unsupported linker extension flag: -z execstack`. The script
recorded: `No compiler emitted an ELF whose PT_GNU_STACK is executable, so NX disabled was not observed.`
NX `disabled` was not exercised by a real ELF on this host.

## Mach-O

`/usr/bin/cc -arch arm64` compiled one image. `cc --version` printed
`Apple clang version 21.0.0 (clang-2100.1.1.101)`. REA reported one image, PIE
`enabled`, `hardened_runtime` `unknown`. `/usr/bin/otool -hv` agreed
(`otoolPie: true`). `otool -version` exited 1. The stored text begins
"error: /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/otool: unknown char `s' in flag -version".

`/usr/bin/cc -arch x86_64 -arch arm64` produced a universal image. REA returned
two parsed slices, `x86_64` and `arm64`, both with PIE `enabled`.
