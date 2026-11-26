# Static CUDA and HIP code objects

`inspect_gpu_code_objects` answers which GPU targets and kernel declarations a
local artifact carries. It reads ELF/PE sections, standalone CUDA fatbins,
CUBIN/PTX, AMDGPU HSA and PAL code objects and Clang HIP bundles, including
CCOB v1/v2/v3. It neither executes the
artifact nor invokes CUDA/ROCm tools. GPU execution, SASS disassembly and host
launch correlation remain outside coverage.

## Inventory targets

Start with a target inventory. MCP defaults to `detail: "summary"`, which
retains complete Evidence and returns the selected page:

```json
{ "path": "/artifacts/library.so", "view": { "collection": "targets" } }
```

Target rows aggregate inventoried payloads and distinguish an unrequested kernel
analysis from a complete or partial one. `objects` pages expose exact object
IDs, compression declarations and encoded/header locations. Fields, exact
filters, batch IDs and stable pagination select the facts delivered. IDs are
positional within the recorded artifact SHA-256. Selecting `object_ids` in a new
inspection requires `expected_sha256` from that inventory; a changed file is
rejected before selected payloads are parsed.

`target` is the inventory declaration used for selection; `payload_target` is
the independently observed inner declaration when available. Object pages keep
both values, their kind, `target_consistency` and inspection coverage even with
selected fields.

| `target_consistency` case                 | Result                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Conflicting base architectures            | Both values kept; object, report and target coverage partial; kernels annotated |
| CUBIN flags give only a base architecture | `base-only`; feature-profile agreement, including `a`/`f` variants, unknown     |
| Standalone declaration                    | `single-source`                                                                 |
| Payload not examined                      | `unexamined`                                                                    |
| Unresolved feature comparison             | `unknown`                                                                       |

An exact AMDGPU target is normalized at its note owner for comparison with a
Clang bundle declaration; raw values remain intact.

Target filters select inventory declarations. An unselected payload's inner
target remains unexamined, so an empty filtered result does not establish that
no enclosed code declares that target. Discovering every inner declaration
requires decoding those payloads.

## Containers and compression

HIP bundle IDs retain the declared processor and v2-v3 `+feature` suffixes for
exact selection. If a recognized AMDGPU bundle ID does not expose a target, the
bounded note discovery used for standalone AMDGPU files establishes it before
filtering; those reads share the inspection work budget. HIP bundle and
metadata note recognition accept the legacy `amdgcn` triple and LLVM's `amdgpu`
subarchitecture triples, including generic processors such as `gfx11-generic`
and `gfx9-4-generic`. Notes with an empty or explicit `unknown` environment are
compared the same way and keep their raw triple spelling.

A HIP target ID identifies a toolchain target, not its payload representation.
Recognized raw or wrapped LLVM bitcode is `unsupported` for kernel metadata,
with the bundle ID, range and selected payload digest retained. Bitcode validity
and inner targets remain unexamined; malformed recognized ELF reports
`malformed`. Standalone bitcode is outside GPU container coverage.

Supported codecs are CUDA raw LZ4 blocks and Zstd, and CCOB zlib/Zstd. Unknown
versions or codecs retain their declarations with explicit limitations. Lengths
are checked before decoding, and CCOB's truncated MD5 is verified against the
decoded bytes.

- **CUDA.** The legacy fatbinary compression flag is retained as an unsupported
  codec with its encoded and decoded extents; compressed bytes are not treated as
  PTX text. A declared decoded length beyond the exact integer range of
  `decoded_size` keeps the encoded range and reports the exact length in a
  limitation. Kernel decoding reports `capacity` for a selected entry with a
  supported codec.
- **CCOB signature.** Only the exact four bytes `CCOB` are accepted;
  high-bit-corrupted bytes are not decoded as ASCII.
- **CCOB v1** stores no total size, so the completed zlib or Zstd stream
  determines its encoded extent. Embedded `CCOB` text is ordinary compressed
  data, and zero-byte alignment after the stream belongs to neither payload. If
  decoding fails or the codec is unsupported, a later `CCOB` marker is only an
  uncertain recovery candidate; the row keeps that limitation and discovery
  remains partial. Interrupted observations omit unfinished v1 rows.
- **CCOB v2 and v3** declare the full encoded extent. A decode that exceeds the
  output budget reports `capacity`, and inspection can continue at the next
  bundle. A v3 decoded length outside the exact integer range of `decoded_size`
  leaves that field null with a limitation.

The declared decoded length bounds decompression. An understated length can
stop decoding before the codec completes, leaving any subsequent recovery extent
unknown; the decoder does not raise its allowance to prove the bad declaration.
A terminal capacity row qualifies its retained range as the containing tail and
does not infer siblings.

`cuda_target_header` retains the OS ABI, normalized raw `e_flags` and exact
header location, validated against its CUBIN object. CUDA OS ABI `0x33` and the
observed `0x41` flags layout use different architecture fields and are decoded
by one ABI-aware owner. Unrecognized layouts keep the header and an unknown
target rather than inventing an SM label.

## Decode kernels

Decode selected targets and return a kernel page in the same call:

```json
{
  "path": "/artifacts/library.so",
  "analysis": "kernels",
  "targets": ["sm_100"],
  "view": {
    "collection": "kernels",
    "names": ["kernel_name"],
    "fields": [
      "name",
      "parameter_count",
      "parameter_bytes",
      "parameters",
      "registers",
      "shared_bytes"
    ]
  }
}
```

Only selected payloads are decoded. Other inventory entries remain with
`not-selected` states, and overall payload coverage stays partial. An empty
kernel page proves no matching retained fact, not that an unexamined payload
contains no kernel. Missing fields are null.

Kernel representations have different meanings:

- **PTX** reports parameter declarations and virtual registers.
  - Shared bytes cover supported static declarations inside the entry, not
    module shared memory, dynamic allocation or physical device resources.
  - PTX 1.0–1.3 declares entry parameters in the body; PTX 1.4 and later uses
    the entry parameter list. Entry-scoped `.pragma` statements before the body
    neither end the declaration nor suppress its body resources.
  - The effective target is the highest-numbered module-scope `.target`,
    including directives after entries. `.target compute_xx` is retained as
    written and compared as its NVIDIA-defined synonym `sm_xx`. Unsupported or
    conflicting target profiles leave the target unknown.
  - Scalar register counts include each bare or `%`-prefixed name and each
    parameterized range, including compact keywords such as `.reg.b32`.
    `.callprototype` formal parameters are excluded.
  - Parameter layout accepts spaced, joined and partly joined pointer
    qualifiers, and alignment before or after the scalar type. A pointer's
    `.align` describes the pointed-to memory, not the parameter's layout.
    Parenthesized or multidimensional array extents, and unsupported
    qualifiers, keep the parameter name and following declarations but yield no
    layout.
  - Unsupported declaration forms, overflowing totals, unsupported layouts and
    unknown shared-memory declarations keep their known facts with an unknown
    value, explicit limitations and partial coverage.
- **CUBIN** identifies CUDA entry symbols and reads numeric `nv.info` records,
  including V2 kernel-parameter sizes, and native section declarations. Global
  register declarations also cover compilers that leave the older text-section
  register field empty. Conflicting register declarations keep the physical
  count unknown, preserve the kernel's other facts, and mark object, report and
  target decoding coverage partial. Missing symbol tables or unresolved section
  names also make that coverage partial even when some kernel facts survive.
- **AMDGPU** processor identity comes from `EF_AMDGPU_MACH` in ELF `e_flags`,
  so known processors are selectable even when no note declares a target. Only
  the processor is reported; version-specific feature flags are not
  interpreted. Unknown processor values remain unknown, and a conflict between
  ELF flags and note metadata leaves the processor unresolved.
  `amd_target_metadata` keeps the raw ELF `os_abi` and the runtime `abi` it
  declares, which alone selects the note schema:

  | `os_abi` | `abi`     | Metadata                                           |
  | -------- | --------- | -------------------------------------------------- |
  | 64       | `amdhsa`  | `amdhsa.kernels` notes become kernels              |
  | 65       | `amdpal`  | `amdpal.pipelines` notes become `amd_pal_metadata` |
  | 66       | `mesa3d`  | Notes unexamined; the object is `unsupported`      |
  | Other    | `unknown` | Notes unexamined; the object is `unsupported`      |
  - **HSA** reads v3+ MessagePack notes; legacy YAML metadata is unsupported.
    Argument counts include hidden ABI arguments when present; SGPR/VGPR counts
    and fixed group/private segment sizes keep their declared meanings.
  - **PAL** graphics and compute pipelines declare no HSA kernels, so kernel
    analysis reports no kernels for them. It reports the `amdpal.version` and,
    per pipeline, its name, type, API, API shader stages with their hardware
    mapping, and each hardware stage's entry point, entry point symbol,
    SGPR/VGPR/AGPR counts, wavefront size, LDS size and scratch memory size.
    Stage names and values are kept as declared; absent fields are null. A
    value of an unexpected type is null with a limitation and partial
    coverage. Register settings, hashes and other pipeline keys are not
    interpreted. A PAL object without a MessagePack note, or with only the
    legacy register-pair note, is `unsupported` with its target retained.
  - Corrupt MessagePack and violated container shapes, such as a pipeline list
    that is not an array, are `malformed`. Note failures preserve earlier parsed
    declarations, including earlier pipelines, and the original failure reason.

Standalone PTX recognition scans up to 16 MiB, allowing leading comments and
whitespace, after which `.version` must be the first module token. Inventory and
kernel inspection use strict UTF-8 and reuse a complete, valid scan. Invalid
encoding can leave a recognizable PTX object with an unknown target. A file
longer than the scan budget, including one that ends mid-character at the
budget, gives partial discovery. An unmatched `}` or a body still open at the end
of the text also leaves the target unknown, matching the unbalanced body that
kernel inspection rejects.

## Read PTX text

Each selected PTX payload becomes a retained UTF-8 text artifact with a SHA-256,
byte length and source coordinates. Compact replies omit it. Read it with
`inspect_analysis_view` and the parent Evidence ID from the compact receipt:

```json
{
  "source": { "kind": "retained-evidence", "evidence_id": "ev_..." },
  "view": {
    "kind": "gpu-code-objects",
    "collection": "ptx",
    "object_id": "...",
    "offset": 0,
    "limit": 4096
  }
}
```

Text offsets use UTF-16 code units and must fall on Unicode scalar boundaries.
Complete Evidence retains the selected text; `export_evidence_bundle` provides
its portable source record. Historical pages never reopen the input file.

## Locations

A location with `container_id: null` uses original file offsets. Other locations
use that inventoried object's decoded byte coordinates; follow its parent,
encoded location and digest back to a native section and the original file.
Decoded offsets are never presented as file offsets. Reads from an ELF or PE GPU
section stay within its declared extent, so neighboring section bytes cannot
complete a truncated embedded bundle header.

## CLI

The CLI uses the same service and contracts. It defaults to
`--detail complete`; `--view` requires `--detail summary` and
`--evidence_output`:

```sh
rea inspect-gpu-code-objects /artifacts/library.so --analysis kernels \
  --targets '["sm_100"]' --detail summary \
  --view '{"collection":"kernels","names":["kernel_name"]}' \
  --evidence_output /analysis/library-gpu.evidence.json --json
```

## Work and limits

The full-file SHA-256 always streams every byte, so this is not a header-only
workflow. Inventory then reads bounded native directories and bundle headers;
CCOB requires decompression to find its inner directory. Kernel analysis reads
selected payloads. `bytes_read` includes hashing and later descriptor reads.

| Resource                                                         | Limit   |
| ---------------------------------------------------------------- | ------- |
| Active inspections                                               | 1       |
| Each input or output buffer                                      | 128 MiB |
| Payload input, decoded output and AMD note reads, per inspection | 512 MiB |
| Retained facts, including selected PTX                           | 16 MiB  |
| Native tables; decoded section names (each)                      | 16 MiB  |
| AMDGPU ELF note source bytes                                     | 8 MiB   |
| Standalone PTX recognition scan                                  | 16 MiB  |
| CUDA ELF record and symbol visits                                | 262,144 |
| CUDA ELF cumulative metadata section reads                       | 128 MiB |
| CUDA ELF temporary index facts (serialized-size accounting)      | 16 MiB  |
| Response page                                                    | 1 MiB   |

Payload work is reserved before reading or allocating, and a capacity refusal
does not reread an aliased payload. AMD note discovery also bounds depth and
container and string allocations, and shares one 262,144-value allowance across
all of a code object's notes, which also bounds the PAL pipeline facts expanded
from them; standalone AMD targets are read from those
notes before target selection, and kernel analysis reuses the parsed
declarations. CUDA ELF limits are checked before index growth and are not claims
about JavaScript heap size. Equivalent scoped metadata ranges and repeated equal
register declarations are coalesced; conflicting values remain unknown.
Parameter sections are parsed once per ELF. Resource refusals and interrupted
observations preserve known facts and explicit uncertainty.
