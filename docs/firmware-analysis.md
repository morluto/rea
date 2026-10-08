# Firmware analysis

REA accepts **Binwalk 3.1.x** for region inspection and **Unblob 26.6.x** for
explicit extraction. The report parsers are verified with Binwalk 3.1.0 and
Unblob 26.6.4. Another build on those lines is accepted, the observed version
is reported, and a limitation records that the parser was not verified against
that build. This first firmware milestone is verified on Linux x64.
No device, root privilege, mount, emulation or execution of extracted programs
is needed. Arbitrary firmware bytes do not pass native executable admission;
select a returned ELF separately for supported Ghidra analysis.

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
Both require util-linux `prlimit`, normally `/usr/bin/prlimit`; override its
absolute path with `REA_FIRMWARE_PRLIMIT_COMMAND` if needed.

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
- `partial` marks unknown/encrypted chunks, reported extraction problems,
  unpublished links/special files or reached depth limits. `complete` means the
  engine finished its configured extraction without those reported conditions;
  default skip rules and format coverage still apply. It does not establish
  complete firmware reconstruction.
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
Native architecture and executable validation still apply. This milestone does
not add MIPS/PPC/RISC-V decompilation, raw flash load profiles, bootloader/device
tree semantics, vulnerability scanning, emulation or hardware runtime capture.

## Resource and lifecycle policy

- Nonempty regular firmware inputs: at most **128 MiB**, copied and hashed into
  a private workspace before analysis. No in-place source modification.
- One queued heavy operation per provider instance; Binwalk one thread and
  Unblob one worker. No automatic parallel extraction engines.
- **120-second** deadline; inherited **1 GiB per-process address-space** limit,
  120 CPU seconds and zero core-dump allowance through `prlimit`.
- JSON reports: at most **8 MiB** and valid UTF-8; malformed encoding and
  oversized reports fail without repairing or truncating producer data.
  Diagnostic output is bounded with exact captured byte counts.
- Default staging budget: **256 MiB** and **10,000 entries**, configurable using
  `max_output_bytes` / `max_output_files` (CLI `--max-output-bytes` /
  `--max-output-files`). Depth defaults to 3, allowed range 1–10.

Staging budgets are polled and rechecked after exit; short-lived overshoot is
possible. The inherited file-size limit bounds each file, not total storage;
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

Additional lanes are explicit, so the base lane stays small:

```sh
# Existing mke2fs and debugfs required; put debugfs on the scoped PATH.
REA_FIRMWARE_VERIFY_EXT4=1 npm run fixtures:firmware
REA_FIRMWARE_VERIFY_EXT4=1 npm run verify:firmware

# Existing Ghidra 12.1.x and its declared JDK required.
REA_FIRMWARE_VERIFY_GHIDRA=1 npm run verify:firmware
```

`REA_FIRMWARE_MKE2FS_COMMAND` selects the optional ext4 fixture producer.
`REA_FIRMWARE_FIXTURE_ROOT` selects generated data storage.
`REA_FIRMWARE_TEST_ENTRYPOINT` can select an isolated installed npm package's
`scripts/rea.mjs` to verify the packaged CLI/MCP workflow. Real coverage here is
generated gzip/USTAR/ext4 with a Linux x64 ELF child; SquashFS, UBIFS, proprietary
firmware, other hosts and architectures remain unverified.
