# Published OpenAPI fixture

`petstore.json.txt` is the original UTF-8 JSON published by the running
[Swagger Petstore 3 application](https://petstore3.swagger.io/api/v3/openapi.json),
retrieved on 2026-11-06. Its API version is `1.0.27`, OpenAPI version is `3.0.4`,
and SHA-256 is `00441c05add60f28da55eb4563d3fb6bbda364ba8eb7b381e2e2c98613005c82`.
It declares 13 paths and 19 inline operations. This is a published application
contract, not a recording proving that any endpoint was exercised or reachable.

The [producer repository](https://github.com/swagger-api/swagger-petstore)
licenses its definition under Apache-2.0; its license is retained in
`LICENSE.petstore.txt`. No authentication credentials were used to retrieve the
public definition. The document contains declared security schemes and example
values, which are source content rather than captured transport credentials.

The `.txt` suffix keeps formatting tools from rewriting the original source.
Tests copy it to a temporary JSON file and inspect it offline. They neither
contact Petstore nor resolve the document's references. CI needs no network to
acquire this fixture and does not rewrite it.
