# auditd log tasks

## Step 1 — record and event inventory

- [x] Streaming line scanner with a fixed per-line ceiling.
- [x] Record header parsing including an optional `node=` prefix.
- [x] Event join on timestamp seconds, milliseconds and serial.
- [x] Malformed, duplicate, out-of-order and interleaved accounting.
- [x] Bounded inline event window with whole-file totals.
- [x] Reader, format descriptor, recognizer and enumeration registration.
- [x] Reader and recognition tests.

## Step 2 — record body decoding

- [ ] Parse key-value fields, keeping repeated fields and argument order.
- [ ] Decode quoted, escaped and hexadecimal values; retain raw beside derived.
- [ ] Decode architecture, syscall, result and permission fields when the
      source provides enough information.

## Step 3 — bounded filtering

- [ ] Filter by time, record type, serial, process, executable, user, result.

## Step 4 — cross-file timeline

- [ ] Order events across rotated files, reporting attribution ambiguity.
