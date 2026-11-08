# Windows Prefetch Evidence

## Proposal

Add a read-only artifact inspection operation that identifies Prefetch format/version, execution metadata, referenced files, and parser coverage without executing the target.

## Verification

Use inert public fixtures for supported versions, malformed headers, truncated records, unknown versions, path encoding, and explicit partial coverage. Keep timestamps and referenced paths tied to source offsets.
