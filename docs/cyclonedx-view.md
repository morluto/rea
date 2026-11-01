# CycloneDX dependencies

`inspect_analysis_view` with `{ "kind": "cyclonedx" }` projects one retained
`inspect_go_binary` or `inspect_rust_binary` Evidence record into a CycloneDX
1.6 JSON document. It reads no target bytes and does not repeat the analysis.

The same Evidence produces the same bytes. The document has no timestamp.
`serialNumber` is a UUID derived from the parent Evidence digest.

`metadata.component` is the binary file. Its name is the file name, and its
hash is the artifact SHA-256. `metadata.tools` names REA and the package
version that produced the document.

Components use Package URLs:

- Go modules use `pkg:golang/<module path>@<version>`. Slashes in the module
  path stay separators. Other characters outside the URL unreserved set are
  percent-encoded. The namespace and name are lowercased. A Go `h1:` sum is
  a directory hash, so it is the property `rea:go:sum` and is not a `hashes`
  entry. When a replacement is a module path, the component is the replacement.
  `rea:go:original-path`, `rea:go:original-version` and `rea:go:original-sum`
  keep the replaced module as recorded, because a Package URL lowercases the
  path. `rea:go:original` is that module's Package URL, and it is absent when
  the path cannot name one. A local path, such as `./dep` or an absolute path,
  has no module identity. Neither does a malformed path, such as one with an
  empty, `.` or `..` segment. Such a component has no Package URL, its
  `bom-ref` is `go-module:<index>`, and the path stays unknown.
- Rust crates from crates.io use `pkg:cargo/<name>@<version>`. A slash in a
  crate name is encoded. `pkg:cargo` resolves to crates.io, so a `local`, `git`
  or other source has no Package URL. Its `bom-ref` is `rust-package:<index>`,
  `rea:cargo:source` keeps the source, and the identity stays unknown. A
  package whose kind is `build` has `scope: excluded`. An omitted
  kind does not set `scope`.

Rust dependency entries follow the embedded package indices, including a
recorded self-edge. Go build information has no module graph, so the document
records only edges from the main module to each module and sets `rea:go:graph`
to `main-module-edges`.

`compositions` is `incomplete` when the producer reports partial coverage and
`unknown` otherwise. It is never `complete`. An embedded record does not
establish that nothing else is linked.

The view keeps artifact identity, the parent Evidence id, a view digest,
coverage, limitations and the unknowns carried by the parent. Unknowns and
limitations are also document properties named `rea:unknown` and
`rea:limitation`, next to `rea:evidence_id`, so an extracted document keeps
them.
The document does not page. A document larger than 1,048,576 bytes is refused.
Recorded fields are counted before any Package URL or document is built, so
`document_bytes` in a refusal is exact or a lower bound, as
`document_bytes_bound` states. The refusal names `export_evidence_bundle`.

One parent produces one document. Several parents are not merged, and SPDX is
not produced.

```bash
rea inspect-go-binary /absolute/path/to/program --json > go-evidence.json
cat > cyclonedx-view.json <<'JSON'
{"source":{"kind":"evidence-file","path":"go-evidence.json"},"view":{"kind":"cyclonedx"}}
JSON
rea inspect-analysis-view cyclonedx-view.json --json | jq '.normalized_result.document' > sbom.cdx.json
```

The same request works for Rust Evidence from `inspect-rust-binary`. MCP uses
`inspect_analysis_view` with a retained, inline or file source.
