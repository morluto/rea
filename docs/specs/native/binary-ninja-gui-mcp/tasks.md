# Binary Ninja GUI MCP provider tasks

- [x] Wire registration, doctor and capability discovery into the existing
      provider selector. Cover valid and invalid registrations with fixture tests.
- [x] Add target binding, read-only native operations and view restoration.
      Cover digest mismatches, partial observations and cancellation with fixture tests.
- [x] Add the live CLI/MCP verifier and record the scope of the historical
      Windows and macOS runs in the [provider guide](../../../providers/binary-ninja.md#verification).
- [ ] Repeat the live verifier on the revision being considered for merge.
      The historical Windows run predates the upstream port, and the macOS run
      predates subsequent fixes. Live Linux, ELF targets and token-protected
      connections remain unverified.
