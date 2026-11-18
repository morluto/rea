# auditd log plan

## Step 1 — record and event inventory (this increment)

- `src/domain/linux/auditdLog.ts`: a streaming scanner that assembles lines,
  parses the `type=… msg=audit(...)` record header, joins records on the full
  audit event identity, and reports per-type, malformed, duplicate,
  out-of-order and interleaved facts.
- `src/artifacts/AuditdLogArtifactReader.ts`: the reader that streams the
  admitted file through the scanner and attaches the inventory to the root
  occurrence, since a log declares no members.
- Format registration: the `auditd-log` id, its metadata schema, a descriptor
  with a reader limitation, a recognizer for the first-line record, and the
  subject, target-kind and snapshot enumerations.
- Tests: reader behavior, and recognition from a first record against plain
  text.

## Step 2 — record body decoding

Decode the key-value body of each supported record type: `SYSCALL`, `EXECVE`,
`PATH`, `CWD`, `PROCTITLE`, `USER_AUTH`, `AVC`, preserving repeated fields,
argument ordering, quoted and escaped values and hex encodings. Retain raw
values beside normalized interpretations.

## Step 3 — bounded filtering

Filter events by time, record type, audit serial, process identifiers,
executable, user identifiers and result, with the filtered-out counts carried
alongside the retained events.

## Step 4 — cross-file timeline

Order events from several rotated log files by source identity and event
identity, reporting ambiguity rather than inventing an order.
