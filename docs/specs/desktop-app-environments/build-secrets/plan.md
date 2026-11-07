# Plan

1. Domain: `buildSecrets.ts` holds the handle schema, the value rules, the
   spellings, `secretsIn` over bytes and a gzip file's inside, and
   `redactSecrets` and `redactSecretsInJson` over text and JSON.
2. Host files: `BuildSecretFiles.ts` resolves the folder from the server's
   environment, reads one handle's file under the ownership and permission
   rules, and lists the handles the folder holds.
3. Typing: `computerActions.ts` adds `type_secret`, which `driverCall` maps to
   `computer_type` with its handle; `DesktopBuildSecrets.ts` keeps the values
   a server types and types one, shaping the result and refusals itself;
   `DesktopBuildComputers.ts` logs the handle and sends the value.
4. Redaction: the action log, the witness record and the build tools'
   registration redact each typed value.
5. Export: `DesktopBuildExport.ts` scans each fetched file before writing it
   and refuses the bundle when one holds a secret.
6. Contract, skill, the build computer guide and this spec; unit tests for
   the spellings and the files, and MCP boundary tests for typing, the
   witness record and the export.
