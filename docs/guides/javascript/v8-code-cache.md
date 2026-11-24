# V8 code cache inspection

`inspect_v8_code_cache` reads one explicitly selected V8 code cache container as static
bytes: a bytenode `.jsc`, the bytes `vm.Script.createCachedData()` writes, or a cache
carried inside a Node single-executable application or an Electron app. It never executes
the file, never starts a V8 runtime, never installs bytenode, and never invokes a
decompiler.

```bash
rea inspect-v8-code-cache /absolute/path/to/module.jsc --json
rea inspect-v8-code-cache /absolute/path/to/module.jsc --min-string-bytes 8 --json
```

The MCP tool is `inspect_v8_code_cache` with the same inputs and the same retained
Evidence.

## What is read

A V8 code cache is a version-dependent container. This reader recognizes two pinned
layouts with their supported header extents and reports observed header values and
payload bytes.

The [Node v24.22.1 V8 serializer](https://github.com/nodejs/node/blob/v24.22.1/deps/v8/src/snapshot/code-serializer.h#L106-L119)
defines seven little-endian 32-bit words followed by pointer-alignment padding.
Four-byte alignment produces a 28-byte header. Eight-byte alignment produces a
32-byte header with a zero padding word. The reader derives the candidate header
extent from the container length and declared payload length. Each observed word
appears in `header.fields` with its byte offset, value, role, and confidence.

| Offset         | Role           | Status      |
| -------------- | -------------- | ----------- |
| `0x00`         | magic          | confirmed   |
| `0x04`         | version hash   | inferred    |
| `0x08`         | source length  | confirmed   |
| `0x0c`         | flag hash      | inferred    |
| `0x10`         | build constant | inferred    |
| `0x14`         | payload length | confirmed   |
| `0x18`, `0x1c` | reserved       | unconfirmed |

`confirmed` means the role is demonstrated by the reader's own tests against the producer.
`inferred` means the word's behaviour is consistent with the role but a different producer
could plausibly differ. `unconfirmed` means the word is reported and nothing more is
claimed.

V8 8.8 through 11.7, which Node 16 through 20 embed, define six words instead. The
[Node v20.18.0 V8 serializer](https://github.com/nodejs/node/blob/v20.18.0/deps/v8/src/snapshot/code-serializer.h#L121-L135)
has no build-constant word, so the payload length is the fifth word and the 24-byte
header needs no alignment padding on either pointer width.

| Offset | Role           | Status      |
| ------ | -------------- | ----------- |
| `0x00` | magic          | confirmed   |
| `0x04` | version hash   | inferred    |
| `0x08` | source length  | inferred    |
| `0x0c` | flag hash      | inferred    |
| `0x10` | payload length | confirmed   |
| `0x14` | reserved       | unconfirmed |

The six-word roles come from that source definition. No producer of those releases was
measured, so only the magic and the payload-length relation, which admission checks on
the container itself, are confirmed. A result for such a container says so in
`limitations`.

Admission requires the V8 magic high half `0xc0de` and a declared payload
that reaches the end of the file: from a 28- or 32-byte header when read from the word
at `0x14`, or from a 24-byte header when read from the word at `0x10`.
`ExternalReferenceTable::kSize` accounts for the varying low half of the magic word.
A container that satisfies both relations is ambiguous, and the reader refuses it.
A candidate 28-byte header followed by a zero word is ambiguous. A 32-byte header
with a four-byte-truncated payload leaves its zero padding at the same offset as a
28-byte header whose payload begins with that word. The reader refuses that case.

Header extent describes the retained bytes. The synthetic narrow and six-word
fixtures test reader admission. Runtime compatibility remains unverified for a 32-bit
producer and for a V8 8.8 through 11.7 producer.

`header.source_length` is the producer's recorded source length in UTF-16 code units.
V8's serializer calls this field the source hash; on the producers measured here its value
equals the source length exactly, including sources whose UTF-8 byte length differs, so the
reader reports it under the name the measurement supports. Treat that name as an
observation, not as a claim about what any other build stores there.
`header.producer` names the producer family from the flag bits in that word. Bit 29
marks `vm.compileFunction` (`compile_function`); bit 30 marks `vm.SourceTextModule`
(`module`). V8 before 13.4, including Node 22, marks a module with bit 31 instead,
which is also reported as `module`. When no flag is present, the producer remains `unknown`:
`vm.Script`, bytenode output and older unflagged function caches cannot be
separated by those bits alone. The source-length mask is `0x1fffffff`, so both
flags sit outside the reported length. This describes the admitted header
profile rather than a version-independent V8 ABI.

## Failed inspection and provenance

After a stable read completes, format and observation-budget refusals retain a
`file-snapshot-hash` partial observation with the selected path, exact SHA-256 and
byte count. This proves which bytes were read; it does not claim the format was
successfully decoded. A refusal before read completion does not invent an identity.
Descriptor cleanup remains owned for retry if finalization fails.

## Embedded byte patterns

`embedded_strings` lists printable runs found in the payload, each with its absolute byte
offset in the selected file and its observed byte length. `min_string_bytes` (default 4)
sets the shortest reported run; `max_strings` caps how many may be reported, and exceeding
it fails without partial success.

These are **byte-pattern observations inside serialized V8 heap data, not parsed heap
objects**. A reported run is not proof V8 retained it as a string. A literal that is absent
from the payload is not proof it is absent from the program: V8 may encode a string in a
form the run scan does not surface, and a string can be produced at runtime rather than
retained.

A run longer than 4096 bytes is reported with `truncated: true` and a `retained_bytes`
prefix.

## Limitations

Every result states these, and they are part of the contract:

- the payload is serialized V8 heap data, not source; no logic is recovered and no
  bytecode is decompiled;
- recovering logic needs a version-pinned V8 decompiler (View8-style) that this tool
  neither provides nor depends on;
- header roles beyond magic, source length, and payload length are version-dependent
  observations;
- the tool never executes the selected file and never claims recovered source.

## Failure behaviour

An unknown magic is a typed `unsupported_target` failure, because the file is not a V8
code cache. A short header, a payload-length disagreement, or bytes past the declared
payload is a typed `invalid_request` failure. Neither produces completed inspection
Evidence; the stable-read partial observation described above is retained when available.

`max_file_bytes` (default 32 MiB, ceiling 64 MiB) is the caller-selected read budget. The
payload SHA-256 is computed over the declared payload, so two containers with the same
payload length and content but different version hashes have different whole-file digests
and identical payload digests.

## Relationship to other tools

- `inspect_binary_layout` reads the surrounding ELF/PE container of a single-executable
  application; it does not decode the embedded code cache.
- A cache embedded in a Node single-executable application or an Electron app must be
  **extracted first**: this reader admits a container whose magic is at byte zero, so
  passing the surrounding ELF/PE executable here returns `unsupported_target`. Run
  `extract_artifact` on the application, then pass the extracted `.jsc` path to this tool.
- `inspect_artifact` inventories the file without decoding V8 structures.
- This tool is in the same family as `inspect_python_pyc`, `inspect_erlang_beam`, and
  `inspect_kernel_module`: one explicit local file, bounded parsing, no execution.
