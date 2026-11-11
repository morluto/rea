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
7. Withheld state: `appWithheld.ts` finds the files and names their
   settings; `DesktopExportWithheld.ts` leaves them out of the seed, reads
   them for the copy, and checks the consent; the class, `env.toml` and the
   README declare them; the draft and the task admission leave them out.
8. Host: the capture passes the sign-in window, the files named and the
   consents to the draft and the export, keeps the withheld files as
   secrets, and supplies a bundle's settings at its start;
   `record_build_consent` records the person's words.
9. Preserve values without inferring secrecy from their shape; only declared
   handles and transport credentials are redacted.
