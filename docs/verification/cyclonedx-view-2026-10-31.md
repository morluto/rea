# CycloneDX view verification - 2026-10-31

`npm run verify:cyclonedx:view` built a Go module and a `cargo auditable`
binary, projected each with `inspect_analysis_view` kind `cyclonedx`, and
checked the documents. The npm script is
`node scripts/verify-cyclonedx-view.mjs`. It loads project source through
`scripts/lib/verifier-source-loader.mjs`. Node printed
`ExperimentalWarning: stripTypeScriptTypes is an experimental feature` during
that load.

This shell's `node -v` was `v24.22.1`, matching `.nvmrc`. The verifier report's
`node` field was `v24.22.1`. This shell's `npm -v` was `11.16.0`, matching
`package.json#packageManager`. The built programs were inspected and were not
executed. `cyclonedx-cli` was not on `PATH`, and the report's
`cyclonedxCli.status` was `absent`.

## Schema

The verifier fetched CycloneDX 1.6.1 schema files and checked their SHA-256
before use. Ajv 8.20.0 with ajv-formats 3.0.1 compiled them with
`strict: false`. Both documents were accepted by that schema and by
`@cyclonedx/cyclonedx-library` 10.3.0 `JsonValidator` for spec version 1.6,
installed only inside the verifier temporary directory.

| File                   | Bytes  | SHA-256                                                            |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| `bom-1.6.schema.json`  | 262597 | `efc54d749e32a6e16abd19394b80b4c67d846e12c782e04505130375f94ea541` |
| `spdx.schema.json`     | 14830  | `c41917196639055e9f9670811bac23ef777732144f3ff5a2f39686f61580dbe6` |
| `jsf-0.82.schema.json` | 8058   | `8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae` |

## Go

`go version` was `go version go1.26.5 darwin/arm64`. The fixture was
`example.com/tool` with `GOPROXY=off` and `replace example.com/dep => ./dep`.
The projection was deterministic, 1539 bytes, with composition aggregate
`unknown` and records `present`. Schema and consumer checks accepted it.

| Component                                 | Role                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| `pkg:golang/example.com/tool@%28devel%29` | main module                                                     |
| `./dep` with no Package URL               | local replacement, with `rea:go:original` for `example.com/dep` |

The compiler's replacement path was `./dep`. The document's only Package URL
was the main module. No component carried a `hashes` entry.

## Rust

`rustc --version` was `rustc 1.97.1 (8bab26f4f 2026-07-14)`. `cargo --version`
was `cargo 1.97.1 (c980f4866 2026-06-30)`. `cargo auditable --version` was not
a cargo command before the run, so the verifier installed `cargo-auditable`
with `cargo install --locked` into its temporary root. The list line it
recorded was `cargo-auditable v0.7.7:`. The projection was deterministic,
1693 bytes, with composition aggregate `unknown` and records `present`.
Schema and consumer checks accepted it.

| Package | Version | Kind in the embedded record |
| ------- | ------- | --------------------------- |
| `app`   | 0.1.0   | omitted (`null`)            |
| `leaf`  | 0.2.0   | omitted (`null`)            |

The fixture lists `leaf` as a normal dependency and a build dependency. This
`cargo-auditable` record kept one `leaf` package and omitted `kind`. The
verifier required an omitted CycloneDX scope for that null kind, and the run
passed. Build scope `excluded` is covered by the domain fixture, not by this
compiler output.
