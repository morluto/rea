# Firmware analysis

REA accepts **Binwalk 3.1.x** for region inspection and **Unblob 26.6.x** for
explicit extraction. The report parsers are verified with Binwalk 3.1.0 and
Unblob 26.6.4. Another build on those lines is accepted, the observed version
is reported, and a limitation records that the parser was not verified against
that build. Binwalk and Unblob operations run only on Linux; other hosts
report the capability as unavailable. Verification covers Linux x64.
No device, root privilege, mount, emulation or execution of extracted programs
is needed. Arbitrary firmware bytes do not pass native executable admission;
select a returned ELF separately for supported Ghidra analysis.

On Linux, Binwalk and Unblob run as REA-owned processes and require a
procps-compatible system `ps`; see the shared
[Linux process prerequisite](../../getting-started/installation.md#linux-owned-process-prerequisite).

## Compare stored firmware components

For supported FIT and legacy uImage containers, use the built-in
`inspect-artifact` / `inspect_artifact` inventory and shared
`compare-artifacts` / `compare_artifacts` workflow. This route needs no Binwalk,
Unblob or extraction: exact logical paths, stored-byte hashes and declared
metadata establish component changes, with source Evidence and explicit unknowns.
The outer container at `.` is separate from its children. See the
[FIT version comparison recipe](../../fit-images.md#comparison) for CLI,
MCP, summary delivery and selected supporting facts. Its real-data verification
covers a pair of OpenWrt FIT releases; it does not establish comparison of
decoded root filesystems or arbitrary firmware formats.

## UEFI flash images and AMI NVRAM

The bundled UEFI tools map PI firmware volumes, FFS files and sections in local
flash images. They also report plausible AMD PSP directory tables and scan for
AMI NVAR chains such as `StdDefaults`. They run independently of Binwalk and
Unblob. FFS file and section discovery applies to FFS2 and FFS3 volumes.
Volumes with other file-system GUIDs retain their header and extent, with the
body reported as unparsed. REA checks the volume header and block map against
the declared volume extent. FFS traversal accounts for volume extensions and
retains later files when the observed header or state establishes the next
file boundary. Otherwise the remaining bytes stay unparsed. Malformed FV extension
entries and conflicts between `UsedSize` and the claimed erased tail appear as
volume-scoped gaps. Readable FFS files remain selectable. A truncated file body
does not receive a verified checksum verdict. For a file without a body
checksum, a wrong fixed integrity marker is reported at its header byte.
A valid header can identify an occupied file range even when the file state
says its body is not yet valid. Those bodies produce a gap while later files
remain selectable.

```sh
rea inspect-uefi-firmware /path/to/flash.bin --json
rea inspect-uefi-nvram /path/to/flash.bin --json
rea extract-uefi-firmware /path/to/flash.bin /path/to/new-output \
  --volume-offset 4096 --source-stream flash --json
```

Use `inspect_uefi_firmware` and `inspect_uefi_nvram` from MCP with
`{"path":"/path/to/flash.bin"}`. A complete UEFI map of a 4 MiB OVMF image is
about 500 KB, so MCP `inspect_uefi_firmware` defaults to `detail: "summary"`.
It retains the complete map in the session and returns volume, file and
section counts with type tallies. Select rows with a `uefi-firmware` view, in
the same call or later through `inspect_analysis_view` with
`normalized_result.parent_evidence_id`:

```json
{
  "name": "inspect_uefi_firmware",
  "arguments": {
    "path": "/path/to/flash.bin",
    "view": {
      "kind": "uefi-firmware",
      "collection": "files",
      "ui_names": ["PlatformDxe"]
    }
  }
}
```

Collections are `volumes`, `files`, `sections`, `unknown-regions`,
`integrity`, `psp-tables` and `psp-candidates`, paged with `offset` and
`limit`. Files match exact `guids`, `ui_names`, `type_names` and
`volume_path`. Each file row lists up to 32 sections with type, offset,
length, SHA-256, `source_stream` and the `truncated` and `malformed` flags,
plus the file's `section_count`. `extract_uefi_firmware` targets those
offsets. The `sections` collection returns complete section records, matches
an exact `file_path` and `type_names`, and pages any longer section list. An empty page reports only the retained
rows; parser limits and coverage remain in the summary. Pass
`detail: "complete"` to receive every record inline. The CLI command always
returns complete Evidence.

To extract a mapped flash-backed volume:

```json
{
  "name": "extract_uefi_firmware",
  "arguments": {
    "path": "/path/to/flash.bin",
    "output_directory": "/path/to/new-output",
    "target": { "kind": "volume", "offset": 4096, "source_stream": null }
  }
}
```

Extraction also accepts `ffs-file`, `section`, and `whole-image` targets.
Volume, file, and section targets include mapped descendants. If inspection
raised `max_volumes`, `max_files`, or `max_depth`, use the same values for
extraction. The equivalent CLI options are `--max-volumes`, `--max-files`, and
`--max-depth`. Unparsed ranges
within the selection appear in `extraction_gaps` and make extraction partial.
The gap names the owning volume, file, or section and its source stream.

Each published file records its owning FFS file in `ffs_file` (GUID, UI name,
type and logical path), or null for bytes outside any mapped file. A whole
OVMF image publishes 560 files, so MCP `extract_uefi_firmware` also defaults
to `detail: "summary"`. The summary returns file, byte, derivation and gap
counts, source, media-type and gap-kind tallies, and the first 8 published
files; a targeted extraction usually fits in that preview. Page the rest with
a `uefi-extraction` view through `inspect_analysis_view` and
`normalized_result.parent_evidence_id`. Calling `extract_uefi_firmware` again
needs another absent output directory and repeats the extraction. For
example, the three largest PE32 files:

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": { "kind": "retained-evidence", "evidence_id": "ev_..." },
    "view": {
      "kind": "uefi-extraction",
      "collection": "files",
      "media_types": ["application/vnd.microsoft.portable-executable"],
      "order": "size-desc",
      "limit": 3
    }
  }
}
```

Collections are `files`, `derivations` and `gaps`. Files match exact
`media_types`, `sources`, `ffs_guids`, `ffs_ui_names` and `ffs_type_names`
and are ordered by publication (`source`) or by `size-desc`. Gaps match exact
`gap_kinds`. Pass `detail: "complete"` to list every file inline.
Bytes outside the file and volume headers that occupy an FFS alignment span
and differ from the volume's erase polarity are reported under the volume.
A gap in one volume leaves a fully extracted sibling's coverage complete.
Erased padding alone does not make a mapped volume partial. A whole-image
request that maps no volumes reports a gap with no published payloads.
A decoded record's
offset starts at zero in the stream named by `source_stream`. Pass that carrier
logical path when extracting by offset. For the original image, use MCP
`source_stream: null` or CLI `--source-stream flash` to disambiguate offsets.
Files carved directly from the image have an `original_file_range`. Decoded
files have a null original range and retain their byte range in the named
stream. Read `derivations` to trace each decoded stream back to its carrier.

LZMA-custom, LZMAF86, and AMD-zlib can yield nested volumes or section chains.
The LZMAF86 worker reverses the x86 branch filter before mapping decoded bytes.
A decoder limit makes inspection partial and appears as a size gap in
extraction. When decoded bytes lack confirmed framing, extraction retains the
decoded stream and reports its unparsed range. Decode derivations cover the
input range examined by the decoder. Unread LZMA carrier bytes are reported
as a gap, including an optional end marker when a known-size stream completes
without examining it. When the common section header
bounds a malformed section, extraction reports that section's range and keeps
later valid sections selectable. Leaf payload ranges exclude type-specific
header fields. Nonzero bytes between aligned sections appear as a gap and
later sections remain selectable. An FV-image section must begin with one
confirmed volume. A missing volume or bytes beyond it produce a gap.
Incomplete UI names remain unknown, with their stored bytes available for
extraction. Readable guided section streams are mapped directly when the
section does not require processing. Reserved guided attributes produce a
gap and leave the carrier available. Guided integrity and authentication
remain unverified.
EFI standard compression and unsupported guided handlers make inspection
partial and produce extraction gaps. Set MCP `include_compressed` to false or pass
`--no-include-compressed` to omit undecoded carriers. PSP tables require a matching directory checksum. Failed checks stay in
the candidate list, and entry locations remain unverified declarations. NVAR results report names, data ranges and hashes,
raw 24-bit record-relative links (with `0xffffff` for terminal links), and
8-bit attributes. A named record holds either a GUID-table index or an inline
GUID. Data-only records have neither. Links remain observations and variable
contents are retained as byte ranges. A nested NVAR chain can begin with a
framed inactive record. The scan continues past framed inactive entries and
reports partial coverage for incomplete successors.

UEFI operations accept up to 128 MiB per image, with a shared limit of 100,000
structural records. Artifact inventory applies the same ceiling to volume
candidates, block maps, extension entries, and FFS headers. Inventory reports
unknown coverage when a volume exceeds the readable range, metadata conflicts
with the bytes, the file walk meets an unparsed suffix, or a scan limit is reached.
The nesting depth defaults to 3 for firmware and 2 for NVAR. Decoding is limited to 64 MiB per stream and 128 MiB across one operation.
An admitted operation has a 60-second deadline covering input, parsing,
decoding, and staging. Owned cleanup can continue past the deadline. Extraction
defaults to 10,000 files and 256 MiB of published file bytes in a fresh path
with an existing parent. Review `coverage`, `limitations`, and
`extraction_gaps` before relying on completeness.

The separate `open_binary` flash admission path requires a signature in the
first MiB and an aligned, structurally plausible FFS2 or FFS3 volume in the
bounded scan. Flash admission provides an artifact inventory. For executable
analysis, pass the returned path of an extracted PE32 payload to
`open_binary` and choose a provider that supports its format and architecture.
Runtime addresses remain unknown.

## Caller-supplied tools

Provide existing tools using absolute executable paths, scoped to your shell:

```sh
export REA_BINWALK_COMMAND=/absolute/path/to/binwalk
export REA_UNBLOB_COMMAND=/absolute/path/to/unblob
```

REA does not install these tools, their dependencies or system packages. It
checks the tool's `--version` banner when executing a request. Binwalk must
print `binwalk <version>` and Unblob must print the version alone. Inspection and
extraction have independent prerequisites; one does not require the other.
Capability discovery recommends `REA_BINWALK_COMMAND` for missing inspection
and `REA_UNBLOB_COMMAND` for missing extraction. Configuring the other engine
does not enable the unavailable operation.
Both require util-linux `prlimit`, normally `/usr/bin/prlimit`; override its
absolute path with `REA_FIRMWARE_PRLIMIT_COMMAND` if needed. `rea doctor` does
not currently inspect firmware readiness. Engine selection/version checks run
when the firmware operation is requested; successful general doctor checks do
not establish firmware tool or external-extractor availability.

REA retains at most 8 MiB of combined stdout and stderr per command. Exceeding
that diagnostic budget stops analysis with an explicit truncated-output error;
child process limits do not bound parent-side pipe retention. Completed commands
drain their output streams before recording diagnostics. Failed worker cleanup
retains the worker and workspace for retry before another request or at shutdown.

Unblob needs the external extractor for the selected format on its inherited
`PATH`: for example, `debugfs` for ext2/ext3/ext4. Its default Landlock sandbox
and skip rules stay enabled. Sandbox startup failures remain actionable errors;
REA does not retry with `--no-sandbox`. Missing extractors reported in a valid
analysis report retain partial results and dependency names inline.

Upstream sources are preserved unmodified as optional pinned submodules:

```sh
git submodule update --init third_party/binwalk third_party/unblob
```

Normal REA builds and npm packages do not include or build these sources or
engine binaries. See [upstream provenance](https://github.com/morluto/rea/blob/main/third_party/README.md).

### Windows submodule checkout

On Windows, the Unblob checkout stops with `error: invalid path`. Several
upstream test fixture names under `tests/integration/` contain characters,
trailing dots, or trailing spaces that NTFS does not allow; REA does not use
those fixtures. Keep the clone, exclude that directory, and retry from the
repository root in PowerShell:

```powershell
git -C third_party/unblob config core.protectNTFS false
git -C third_party/unblob sparse-checkout set --no-cone '/*' '!/tests/integration/'
git submodule update third_party/unblob
```

Both settings are required. While `core.protectNTFS` is enabled, Git for
Windows also rejects index paths that the sparse pattern excludes; the pattern
keeps the invalid names out of the worktree. The setting applies only to the
Unblob submodule. In Git Bash, prefix the `sparse-checkout` command with
`MSYS_NO_PATHCONV=1`; otherwise `!/tests/integration/` is rewritten as a
Windows path.

The extraction destination must be absent with an existing writable parent.
REA checks that selection before starting an engine and still acquires it
exclusively during publication. Invalid sources and destinations identify the
caller argument; failures inside an acquired workspace keep their own cause.
Published file `relative_path` preserves producer spelling for lineage; `path`
uses the writer's actual normalized filename. An extracted filename that cannot
be represented losslessly as UTF-8 fails publication explicitly with its raw
name bytes in hexadecimal instead of silently omitting the entry.
Unpublished symlinks retain the extracted tree's target bytes in lowercase
`link_target_hex`; `link_target` is null when those bytes are not valid UTF-8.
Older retained Evidence may omit the hexadecimal field. Unblob may have rewritten
the target before REA observed it, so these bytes are not necessarily those stored
in the firmware image.

## CLI and MCP

```sh
rea inspect-firmware-regions /path/to/firmware.bin
rea extract-firmware /path/to/firmware.bin /path/to/new-output
rea extract-firmware /path/to/firmware.bin /path/to/selected-output \
  --offset 64 --length 4096 --max-depth 3
```

The corresponding MCP tools accept the same intent:

```json
{
  "name": "inspect_firmware_regions",
  "arguments": { "path": "/path/to/firmware.bin" }
}
```

```json
{
  "name": "extract_firmware",
  "arguments": {
    "path": "/path/to/firmware.bin",
    "output_directory": "/path/to/new-output",
    "range": { "offset": 64, "length": 4096 },
    "max_depth": 3
  }
}
```

Both return Evidence with the original path and SHA-256, raw producer reports,
actual executable path/digest, version and limitations. Binwalk signature UUIDs
and Unblob blob IDs are producer-local identities; compare content hashes and
source ranges across runs. A matching version does not attest an installed
build's source revision, so that field remains unknown.

### Interpret the results

- Region offsets refer to bytes in the original firmware. `reported_size`
  preserves Binwalk's output; `size_basis=provider_reported_validation_unknown`
  reflects that Binwalk can replace unknown lengths with the next signature or
  EOF before serialization. Neither a signature nor its confidence byte proves
  a valid partition, encryption or runtime behavior.
- Extraction returns regular file paths, independently verified SHA-256 values,
  producer hashes when available, chunks, diagnostics and task derivations.
  Unblob's task report is unordered; REA resolves relationships by paths and
  blob IDs. Logical references use `$input`, `$output`, or `$output/<relative-path>`
  so a real file named `$input` stays distinct from the original input.
  Chunk offsets belong to the task's input file. Only chunks in the
  selected input have a known `root_file_range`, adjusted by the selected offset.
- Decompressed children have unknown original byte ranges and runtime addresses.
  Task lineage does not establish a byte-for-byte mapping through decompression.
- `partial` marks unknown/encrypted chunks, selected input bytes outside all
  reported chunk intervals, reported extraction problems,
  unpublished links/special files or reached depth limits. `complete` means the
  selected input is covered by reported chunk intervals and the engine finished
  its configured extraction without those reported conditions;
  default skip rules and format coverage still apply. It does not establish
  complete firmware reconstruction.
- `extraction_gaps` makes those conditions recoverable: a row identifies an
  unextracted region or a failed task/stage. A chunk retains its identity and
  byte range, plus its original-file range when it belongs to the selected input.
  `unclassified-range` rows identify selected input intervals with no reported
  chunk; their provider identity and handler stay null. An empty chunk inventory
  therefore cannot establish complete extraction of a nonempty selected input.
  A multi-file stage retains its reported ID and handler with unknown byte ranges;
  a standalone task failure keeps unavailable stage identity null. Rows retain exact dependency names from
  the producer's missing-dependency reports; an accepted report with no names
  remains a failure with unknown dependencies; no executable identity or specific installation step is inferred. Each row's `continuation_id`
  references one instruction in `extraction_continuations`, so many regions
  share recovery prose without losing any region identity. Instructions use
  already configured capabilities where one exists. Every extraction rerun
  requires a fresh absent `output_directory`, preserving the prior evidence.
  Unblob's declared `ERROR` severity establishes an extraction failure,
  including standalone `UnknownError` task exceptions. Warnings and resolved
  extraction problems remain diagnostics with partial coverage; they do not
  establish failed extractor stages. Standalone errors do not acquire a nearby
  chunk's handler or byte range.
  Nested unknown chunks use `inspect_firmware_regions` on the actual published
  child rather than repeating the same extraction with unchanged handlers.
  Inspection requires separately configured Binwalk (`REA_BINWALK_COMMAND`);
  without it, the inspection step is unavailable and the region remains unexamined. A listed gap does not
  mean the target is corrupt or that a retained region is empty; REA installs
  nothing.
- The destination must be absent, absolute, with an existing parent. Publication
  uses exclusive, symlink-resistant writes and durable digest readback. Existing
  destinations are never overwritten. This is not an atomic directory rename:
  a new tree can be visible while files are written. Failed uncommitted output
  is rolled back. Symlinks and special files are recorded without publication;
  empty directories, ownership and executable permission bits are not reproduced.

Select a verified native child for the existing tools:

```json
{
  "name": "open_binary",
  "arguments": {
    "path": "/path/from/extraction/usr/bin/program",
    "provider_id": "ghidra"
  }
}
```

Then use `analyze_function`, `inspect_native_api` or the other native primitives.
Native architecture and executable validation still apply. Generic
[MIPS ELF](../../providers/ghidra-mips.md) and [RISC-V ELF](../../providers/ghidra-riscv.md) lanes are separate
documents with their own admission boundaries. This milestone does
not add PPC decompilation, raw flash load profiles, bootloader/device
tree semantics, vulnerability scanning, emulation or hardware runtime capture.

## Resource and lifecycle policy

- Nonempty regular firmware inputs: at most **128 MiB**, copied and hashed into
  a private workspace before analysis. Growth beyond that allowance during
  copying receives the same typed input refusal as an already oversized file.
  Supply a stable copy within the allowance. No in-place source modification.
- One queued heavy operation per provider instance; Binwalk one thread and
  Unblob one worker. No automatic parallel extraction engines.
- Analysis defaults to **120 seconds**, from tool resolution and input snapshot
  through inspection and its final private-workspace cleanup, or extraction
  through report consumption and inventory, excluding queue waiting and retained
  cleanup admission. Inspection has no publication phase. Select `analysis_timeout_ms` in either MCP operation or
  `--analysis-timeout-ms` in either CLI command for slower analysis. Current
  results retain the actual budget; an absent historical value means unknown.
  Extraction publication and its final
  cleanup start a separate **120-second** budget; select
  `publication_timeout_ms` in MCP or `--publication-timeout-ms` in CLI for a slow
  destination. Valid budgets are integers from 1 through 2,147,483,647 ms (the
  timer representation limit). Publication timeouts identify their phase and
  verified file progress; verified writes before atomic commit are not a claim
  that output remains published after rollback. Caller cancellation applies to
  both phases and final cleanup. Phase handoff, publication commit and final
  completion also check monotonic elapsed time, so delayed timer callbacks
  cannot revive an expired budget.
- Analysis timeout recovery names the selected budget and the analysis control,
  not the later publication control. Keep the client call timeout above analysis,
  publication and cleanup headroom; keep the input/range/question unchanged.
  Resolve any reported incomplete cleanup before retrying. Raising wall time
  does not raise fixed CPU, memory, report, diagnostic or input limits.
- Inherited **1 GiB per-process address-space** limit,
  120 CPU seconds and zero core-dump allowance through `prlimit`.
- JSON reports: at most **8 MiB** and valid UTF-8; malformed encoding and
  oversized reports fail without repairing or truncating producer data.
  Exit status 0 is not an empty result: a missing, empty, malformed or
  oversized report fails with `unreadable_output`, its `report_state`, the
  command, exit status and captured output. REA does not retry automatically.
  Diagnostic output is bounded with exact captured byte counts.
- Default staging budget: **256 MiB** and **10,000 entries**, configurable using
  `max_output_bytes` / `max_output_files` (CLI `--max-output-bytes` /
  `--max-output-files`). Exceeding either selected staging budget returns a
  nonretryable resource constraint naming the selected limit. Depth defaults to
  3, allowed range 1–10.

Staging budgets are polled and rechecked after exit; short-lived overshoot is
possible. The per-file process limit is one byte above the larger of the selected
payload budget and the fixed report/diagnostic file allowances, so a small payload
selection still permits the mandatory report, and a staged file the kernel stops
at the limit exceeds its budget instead of passing as complete. A tighter
inherited host limit still applies and can remove that byte, so a staged file
that reaches the installed limit is rejected as possibly truncated.
The inherited file-size limit bounds each file, not total storage;
address-space limits are per process, not an aggregate memory quota. Worker
count is not CPU affinity for every external extractor. These limits do not
claim cgroup/container containment. Cancellation cleans the owned process group
before removing its workspace; uncertain cleanup retains resources and blocks
further operations in that provider instance.

## Verification

Generate small public, source-derived fixtures into ignored `_reference/`:

```sh
npm run fixtures:firmware
npm run verify:firmware
```

Fixture generation requires existing Python 3 and a host C compiler (`cc`);
override with `REA_FIRMWARE_PYTHON` / `REA_FIRMWARE_CC`. The independent oracle
records gzip offset/length and extracted file hashes. Real verification checks
CLI/MCP, full-file and selected-range extraction, unknown chunks, depth limits,
content parity and unchanged source bytes. No binary fixture is committed.

The optional missing-extractor lane asserts dependency names and the owning
handler in `extraction_gaps`. Those assertions must be run against the pinned
Unblob release to establish real-provider coverage; synthetic producer fixtures
alone do not verify Unblob's report nesting or stage identities. The gap ownership
claims remain unverified against real Unblob until that lane runs.

Additional lanes are explicit, so the base lane stays small:

```sh
# Existing mke2fs and debugfs required; put debugfs on the scoped PATH.
REA_FIRMWARE_VERIFY_EXT4=1 npm run fixtures:firmware
REA_FIRMWARE_VERIFY_EXT4=1 npm run verify:firmware

# Existing Ghidra 12.x (>=12.2) and its declared JDK required.
REA_FIRMWARE_VERIFY_GHIDRA=1 npm run verify:firmware
```

`REA_FIRMWARE_MKE2FS_COMMAND` selects the optional ext4 fixture producer.
`REA_FIRMWARE_FIXTURE_ROOT` selects generated data storage.
`REA_FIRMWARE_TEST_ENTRYPOINT` can select an isolated installed npm package's
`scripts/rea.mjs` to verify the packaged CLI/MCP workflow. Real coverage here is
generated gzip/USTAR/ext4 with a Linux x64 ELF child; SquashFS, UBIFS, proprietary
firmware, other hosts and architectures remain unverified.

## Inspect ESP images

Use `inspect-artifact` / `inspect_artifact` on an ESP32-family app or
bootloader image, such as an OTA download or app partition, for its chip,
classified segments, checksum and SHA-256 results, descriptor and Secure Boot
v2 signature blocks. `extract-artifact` / `extract_artifact` writes one file
per segment and signature block. Reading is portable and needs no external
tool. See [ESP images](../../esp-image.md).

## Inspect ESP flash dumps

Use the same tools on a whole-flash dump, such as `esptool read-flash 0 ALL`
output. The inventory reports the bootloader, the partition table and how it
was found, each partition with its declared type, flags and digest, ESP image
facts for the bootloader and each app partition, and the OTA records with a
derived selection; the running partition stays unknown. Extraction writes
each partition, `nvs_keys` included, as an ordinary file. For a dump that
does not start at flash address 0, select `esp-flash-image` with
`flash_offset`. See [ESP flash images](../../esp-flash-image.md).

## Inspect extracted devicetrees

Use [`inspect_devicetree`](../../devicetree.md) / `rea inspect-devicetree` on an
extracted DTB for its node/property tree, reservations, hardware summary and
selected phandle relationships. FDT v16/v17 inspection is portable and requires
no external tool or disassembler.

## Inspect Intel HEX and S-record images

Use `inspect-artifact` / `inspect_artifact` on an Intel HEX or Motorola S-record
file for its address regions, declared start address and record facts, then
`extract-artifact` / `extract_artifact` for one raw file per region. Decoding is
portable and requires no external tool. See
[Intel HEX and S-record images](../../hex-records.md).

## Inspect U-Boot legacy uImages

`inspect-artifact` / `extract-artifact` recognize a legacy uImage by its
`0x27051956` magic and inventory it without running or decompressing it.
The root facts record the 64-byte header (architecture, OS, type, and
compression as raw values and names, load and entry addresses, image name,
and timestamp) with the header and data CRC32 verified; the stored payload
is extractable as `payload.bin`, and multi-file and script images additionally
expose each sub-image as `image-<n>.bin` from the stored size table. Declared
addresses are facts from the header, not proven entry points, and compressed
payloads stay as stored. Intel HEX/S-record and FIT images are separate
readers and are not covered here. See [U-Boot legacy uImage](../../uimage.md) for
component padding, preserved names, resource policies and verification scope.

## Inspect Android OTA update payloads

`inspect-artifact` / `extract-artifact` recognize a CrAU v2 `payload.bin` by
magic and inventory its DeltaArchiveManifest without applying the update or
verifying signatures. Full payloads can reconstruct REPLACE, ZERO and
REPLACE_ZSTD partition images; delta operations stay inventoried and refuse
extraction. See [Android OTA update payloads](android-ota-payload.md)
for header facts, operation types, limits and verification scope.

## Expand Android sparse images

`inspect-artifact` / `extract-artifact` recognize an Android sparse image
(`0xED26FF3A`) by magic, record its header and chunk counts, and expand it to
one `image.raw` child offline. RAW chunks are copied, FILL chunks repeated and
DONT_CARE chunks written as zeros; stored checksums are not verified. The
expanded child is classified again, so a sparse-wrapped boot image continues
to the Android boot image reader. See [Android sparse images](android-sparse-image.md).

## Inspect UF2 and DfuSe images

Use `inspect-artifact` / `inspect_artifact` on a UF2 file for each familyID's
address regions and its block numbering, or on a DfuSe file for its targets,
elements and DFU suffix, then `extract-artifact` / `extract_artifact` for one
raw file per region or element. A DfuSe suffix CRC mismatch follows
`integrity_policy`. Decoding is portable and requires no external tool. See
[UF2 and DfuSe images](../../uf2-dfuse.md).

## Inspect U-Boot FIT images

Use `inspect-artifact` / `inspect_artifact` on a U-Boot FIT (`.itb`) for its
images, declared load and entry addresses, configurations and verified hashes,
then `extract-artifact` / `extract_artifact` for one raw file per image.
Decoding is portable and requires no external tool. See
[U-Boot FIT images](../../fit-images.md).

## Inspect Android boot and vendor_boot images

`inspect-artifact` / `extract-artifact` recognize `ANDROID!` (header versions
0 through 4) and `VNDRBOOT` (vendor_boot versions 3 and 4) by magic. The root
records page size, component sizes, the command line, OS version and security
patch level when the header has them, the board name, and the header digest.
Children are the stored kernel, ramdisk, second stage, recovery DTBO, DTB,
vendor ramdisk table entries, bootconfig, and v4 signature. gzip, lz4, and
zstd are recorded from leading magic and left compressed. An AVB footer is
reported with its sizes and is not verified. `ANDROID!` does not say whether
the file was boot, init_boot, or recovery. Extract `dtb` and pass that file
to `inspect-devicetree`. See [Android boot images](../../android-boot-image.md).
