# Published OpenAPI YAML fixture

`petstore.yaml.txt` is `petstore.json.txt` serialized to YAML 1.2 block style
with no content change, retrieved and converted on 2026-11-09. It declares the
same OpenAPI version `3.0.4`, the same API version `1.0.27`, the same 13 paths
and 19 inline operations, and its SHA-256 is
`a39ae3e65a16abc7ce67320984b669b6ca7a7f6b8ed451247f548e4b227291a7`.

It exists so the YAML profile is compared against a published application
contract rather than only against hand-written documents. Provenance and
licensing are those of `petstore.json.txt`; see [`README.md`](README.md) and
`LICENSE.petstore.txt`.

The `.txt` suffix keeps formatting tools from rewriting the source. Tests copy
it to a temporary YAML file and inspect it offline.
