# Windows Registry hive Evidence

## Proposal

Add a read-only offline inspection operation for Registry hives and transaction logs, preserving hive identity, key/value structure, transaction state, and explicit parser limitations.

## Verification

Use inert fixtures for valid hives, transaction replay, deleted cells, truncated bins, unsupported versions, malformed security descriptors, and bounded traversal. Never modify or mount the source hive.
