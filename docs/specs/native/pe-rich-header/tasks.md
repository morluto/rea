# Tasks

This specification was written after the first implementation, when the
repository adopted feature specifications. The items record the work in the
pull request.

- [x] Define the single-feature scope, contract and implementation plan.
- [x] Add parser tests with an independent checksum, then the parser.
- [x] Add the schema, provider, service, CLI and MCP contracts with boundary
      tests.
- [x] Report DOS MZ images as `unsupported_target`, and keep the file identity
      when decoding fails after the read.
- [x] Accept only decimal integers for the CLI numeric options.
- [x] Compare with pefile over 17,896 installed Windows images; none differ.
- [x] Write the guide; pass focused, static and documentation checks.
- [ ] Run on Linux and macOS hosts. Only Windows 11 has been run.
