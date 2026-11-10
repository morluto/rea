# Plan

1. Schema: optional `package_file` (name, SHA-256, size, package, version,
   architecture, Depends and Pre-Depends entries) and `package_file_reason` in
   the capture's package section, so captures written before them still
   parse.
2. Pure readers: `dpkg-deb --field` output on the deb822 paragraph reader the
   apt sources parser already uses, the match against the installed version,
   and the names apt installs before the file.
3. Host adapter: `dpkg-deb` through the inventory's query runner, then the
   shared stable-file hash for the SHA-256 and size, with a failed close
   carried by its cleanup lease; `capture-desktop-application --package-file`.
   The library walk also runs for a local install, with apt's origins read for
   it.
4. Export: the install decision takes `--package-url` and its refusals carry
   their field and remediation; the class renders `downloads=[Download(...)]`
   and `run=[RunScript(...)]` beside `packages`, the export writes
   `install-package.sh`, and the README and limitations say what the bundle
   does not hold and what the operator answers for.
5. Docs and tests: real `dpkg-deb` output for the parser, a fake query runner
   for the inventory, the export service for a local-deb capture and its
   refusals, the run script under `sh` with a stub `dpkg`, a package built by
   `dpkg-deb` on Linux, and the class declared with agentenv-framework
   0.9.1431. A real VariCAD capture and export follow.
