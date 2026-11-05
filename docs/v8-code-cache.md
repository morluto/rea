# V8 code cache inspection

`inspect_v8_code_cache` reads one explicitly selected V8 code cache container as static
bytes: a bytenode `.jsc`, the bytes `vm.Script.createCachedData()` writes, or a cache
carried inside a Node single-executable application or an Electron app. It never executes
the file, never starts a V8 runtime, never installs bytenode, and never invokes a
decompiler.

```bash
rea inspect-v8-code-cache /absolute/path/to/module.jsc --json
rea inspect-v8-code-cache /absolute/path/to/module.jsc --minStringBytes 8 --json
```

The MCP tool is `inspect_v8_code_cache` with the same inputs and the same retained
Evidence.

## What is read

A V8 code cache is a producer-written container, not a documented file format. This reader
admits one container shape and reports everything else as an observation, so a build it
has never seen still yields facts instead of a false parse.

The 32-byte header is eight little-endian 32-bit words. Every word is reported in
`header.fields` with its byte offset, its observed value, the role this reader believes it
has, and how confident that role is:

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

Only three facts gate admission:

1. the header size this reader pins (32 bytes);
2. the V8 code cache magic high half, `0xc0de`. The low half is
   `ExternalReferenceTable::kSize` and varies per V8 build, so it is reported as a build
   fingerprint and never required to match a fixed value;
3. the declared payload length must equal the bytes that follow the header exactly.

`header.source_length` is the producer's recorded source length in UTF-16 code units.
V8's serializer calls this field the source hash; on the producers measured here its value
equals the source length exactly, including sources whose UTF-8 byte length differs, so the
reader reports it under the name the measurement supports. Treat that name as an
observation, not as a claim about what any other build stores there.
`header.producer` names the producer family: `script` for `vm.Script` and bytenode output,
`compile_function` when V8's function-compilation bit is set in that word.

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
payload is a typed `invalid_request` failure. Neither is a partial parse, and no Evidence
is recorded for them.

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
