# WeChat mini-program wxapkg archives

`inspect-artifact` and `extract-artifact` read plaintext WeChat mini-program
package (`.wxapkg`) containers without running WeChat or an unpacker. The
plaintext form starts with a `0xBE` mark and an 18-byte big-endian header:
an unknown `info` field producers leave zero, the member-table byte length,
the member-data byte length, a `0xED` mark and the member count. The table
region then carries one name/offset/size row per member; member bytes are
stored verbatim at absolute file offsets.

Inspection retains the header facts: `info`, index and data lengths, member
count and directory status. Members retain declared source paths, absolute
carrier offsets and declared sizes, so `source_location` reports real file
positions. Member reads only examine their declared range in bounded 64 KiB
chunks. Carrier freshness is checked when a member is opened and after its
stream completes. Reader close cancels and joins outstanding streams before
releasing its descriptor.

Encrypted PC-client packages start with the `V1MMWX` magic instead of the
plain header. They keep their format identity but report `encrypted`
directory status with unknown coverage: member identities and bytes remain
unknown and no decryption is attempted, so extraction refuses with a typed
error rather than producing ciphertext. Declared tables that exceed the
file, member extents outside the file or inside the header, truncated rows,
invalid UTF-8 names, and counts that cannot fit their table are
malformed-input errors.

## Resource bounds

These are resource policies, not format maxima. The encoded member table is
limited to 16 MiB and its buffer, parsed rows, retained entries and escaped
path projections share a conservative 64 MiB admission budget, reserved
before allocation; a declared member name is limited to 64 KiB. A reader
admits four active member streams. The shared archive plaintext-work ceiling
is the larger of 256 MiB and 500 times carrier size: every declared member
extent is charged, including aliases that overlap one stored range. A
separate member-I/O budget allows four times the larger of 1,024 and the sum
of the member count and declared 64 KiB plaintext chunks, bounding repeated
tiny-member reads independently of output bytes.

## CLI

```sh
rea inspect-artifact app.wxapkg --detail summary \
  --evidence_output evidence/package.json --json
rea extract-artifact app.wxapkg --json
```

Detection is byte-based on the `0xBE`/`0xED` marks or the `V1MMWX` magic, so
`.wxapkg`, `__APP__.wxapkg` and extensionless cache files all classify as
`wxapkg` containers. Compact delivery keeps complete Evidence in the
requested bundle.

## Verification scope

Synthetic fixtures cover plaintext headers, multiple members, empty members,
chunked reads, unicode and dotted names, malformed marks, truncated tables,
invalid UTF-8, table and directory-budget admission, member extents inside
the header or beyond the file, an overstated first row consuming its
successor, V1MMWX packages, cancellation inside member reads, paused
iteration, close during I/O, cleanup retry, stream capacity and carrier
freshness. Compiled CLI and full/compact MCP tests cover inventory and
extraction.

No real producer package was verified: no owned sample was available when
this support landed, so coverage rests on format documentation and the
synthetic corpus. `wxml`/`wxss` source recovery, compiled bundle semantics,
subpackage relationships and runtime behavior are outside this container
reader's verification scope.
