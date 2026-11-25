# PE overlay

Use `inspect_pe_overlay` to report bytes appended after an explicit local PE32 or
PE32+ image. No disassembler, Windows host, or target execution is required.

```sh
rea inspect-pe-overlay /absolute/path/to/application.exe --json
```

MCP accepts `{ "path": "/absolute/path/to/application.exe" }`. CLI paths may be
relative to the current directory; MCP paths must be absolute.

The image end is the maximum of `SizeOfHeaders` and each contributing section's
declared `PointerToRawData + SizeOfRawData`, so bytes a section declares are
never reported as overlay. Each section also records the loader's mapping
offset: `PointerToRawData` rounded down to a multiple of 512 bytes unless the
image declares matching nonzero `SectionAlignment` and `FileAlignment` below
512 bytes, which retain their raw offsets. Rounding does not shorten the image
end. Zero-size sections and sections whose only content flag is
`IMAGE_SCN_CNT_UNINITIALIZED_DATA` are listed and do not move the image end. A
nonempty section that also sets `IMAGE_SCN_CNT_CODE` or
`IMAGE_SCN_CNT_INITIALIZED_DATA` keeps its raw bytes in the image.
`present` is false when the file ends at that image end. The report lists at
most 96 sections, the Windows loader limit the PE format documents. When
`NumberOfSections` declares more, `section_coverage.status` is `partial`, a
limitation names the declared count, and every declared section still counts
toward the image end. `header_anomalies` carries the declared header values
the shared PE reader accepted but the loader ignores or caps, such as a
`SizeOfHeaders` that ends before the section table, so the reported
`size_of_headers` keeps its warning.

The overlay is the half-open span from the image end to the file size.
`security_directory` records the declared `IMAGE_DIRECTORY_ENTRY_SECURITY`
offset and size with its outcome: `absent`, `table`, or `malformed` with the
defect. When a `table` lies entirely inside the overlay span, the report
splits it into a `certificate_table` range and the surrounding `other` ranges,
in file order. A table that sits wholly inside the mapped image stays out of
the split. A table that starts inside the image and ends in the overlay keeps
the overlay span: its bytes stay in one `other` range and a limitation names the
overlap. The shared directory checks require an eight-byte-aligned offset
outside the headers, a size that can hold a certificate entry header and is a
multiple of eight bytes, and a range inside the file. If a check fails, a
limitation names the defect and the bytes stay in ordinary `other` ranges.
Each `other` range includes its offset, size, SHA-256, a Shannon entropy
sample of at most the first 4096 bytes, and the first 16 bytes as hex.
`leading_format` uses the shared probes for bounded prefixes and trailers,
including binary and XML plist signatures. Formats that need more context,
including nested native executables and ESP flash layouts, and markers without
a probe, such as 7z, CAB, NSIS, and Inno, stay `unrecognized`. A
`certificate_table` range carries the admitted directory offset and size;
use `inspect_pe_certificates` to check the entry framing and inspect the entries.

This inspection does not identify packers and does not treat an overlay as a
packed payload. It does not verify Authenticode signatures, certificate chains,
or digest coverage. Bytes inside the mapped image, including section slack
between virtual size and raw size, are not reported as overlay; appended data
can hide there.

The default read budget is 64 MiB (`max_file_bytes`, ceiling 512 MiB); a larger
file fails. The entropy window is fixed. Raw ranges are bounds-checked only for
sections that move the image end. When such a section's
`PointerToRawData + SizeOfRawData` leaves the file, or `SizeOfHeaders` exceeds
the file size, the inspection fails without a partial report, and a section
failure names that section's index. Zero-size and uninitialized-only sections
are listed as declared without that check, so a successful report does not
mean every declared raw range lies inside the file.

Layout reference: [Microsoft PE format](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).
