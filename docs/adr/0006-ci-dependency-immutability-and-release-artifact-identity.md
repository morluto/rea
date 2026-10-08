# ADR-0006: CI dependency immutability and release artifact identity

- Status: Accepted
- Date: 2026-10-08
- Implementation status: Partially implemented. All GitHub Actions references are
  pinned to reviewed full commit SHAs and enforced by a repository test. The
  release workflow verifies and publishes one retained tarball path, but still
  builds it inside the OIDC-enabled job. Exact Node/npm runtime assertion, an
  unprivileged artifact handoff to a minimal publisher, exact-SHA CI authorization,
  provider lane closure, and registry readback remain release blockers.

## Context

REA publishes a security-sensitive package and MCP server from GitHub Actions.
Release jobs receive repository-write or OIDC authority. Mutable action tags,
build steps inside the publish job, and repacking after verification weaken the
link between reviewed source, tested package, and registry object.

A release branch-tip check is necessary but insufficient: the exact candidate
must also have successful required checks, and the bytes verified must be the
bytes published.

## Decision

1. Every third-party GitHub Action is referenced by a full 40-character commit
   SHA. A human-readable release tag remains in a comment. A static test rejects
   mutable tags.
2. Node and npm versions are executable policy, not metadata. Every install,
   build, verify, and publish job must assert the pinned versions before dependency
   installation.
3. Build and verification run in jobs without publication credentials. The
   release artifact is packed once into a controlled path, hashed, and uploaded as
   an immutable workflow artifact with its file manifest and source SHA.
4. The minimal publish job downloads that exact artifact, verifies its digest,
   and runs `npm publish <exact-tarball>`. It does not run `npm ci`, build, or
   `prepack`.
5. Release authorization is bound to the exact source SHA. A machine-readable
   required-check policy must prove that core CI and every capability/provider lane
   required by the candidate diff completed successfully for that SHA.
6. npm readback must match package name, version, integrity, provenance/source
   commit, and expected complete tool catalog. MCP Registry readback must match
   server identity, package coordinate, version, and source SHA.
7. One release receipt records source SHA, tag, workflow run and attempt,
   tarball SHA-256/SHA-512, npm integrity, MCP identity, required-check results, and
   readback timestamps. It is retained as a workflow artifact.
8. Partial publication is recovered idempotently from the same receipt and
   artifact. Tags are not deleted and immutable registry versions are not
   republished or silently replaced.

## Options considered

### Verify one tarball and let `npm publish` rebuild

Rejected. Two lifecycle executions can produce different bytes.

### Build and publish in one OIDC-enabled job

Rejected. Dependency lifecycle and compiler execution would receive publication
authority.

### Pack once, separate authority, verify registry readback

Accepted. It minimizes credential exposure and establishes byte identity from
source through publication.

## Consequences

- Action updates become explicit reviewed dependency changes.
- Release jobs gain more artifact plumbing but a smaller trusted computing base.
- A release cannot proceed merely because a maintainer followed a checklist; the
  workflow must prove exact-SHA closure.
- Repository branch/ruleset protection remains an external GitHub setting and
  must be configured and read back separately.

## Release hold conditions

Publication remains on hold when any of the following is true:

- the exact source SHA lacks a required successful lane;
- the tested tarball digest differs from the publish candidate;
- a publish job installs dependencies or rebuilds package content;
- npm or MCP Registry readback is absent or mismatched;
- release branch protections/rulesets cannot be verified;
- the declared Node/npm versions differ from the executing toolchain.
