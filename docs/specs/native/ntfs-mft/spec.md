# NTFS $MFT and USN Journal inspection

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the artifact inventory
guide.

## Problem and outcome

REA has no reader for acquired NTFS metadata artifacts. An analyst holding a
captured `$MFT` stream cannot ask which FILE records it contains, whether their
update-sequence fixups survived acquisition, or which records are directories,
extensions of another record, or no longer in use. Add offline, read-only
inventory of a selected `$MFT` file, delivered in steps so each one merges on
its own.

## Requirements

- Recognize a `$MFT` stream by the `FILE` signature of its first record, under
  any file name, and route it to a dedicated artifact reader.
- Validate each FILE record header: the `FILE` signature, sequence number, flags,
  used and total byte counts, base record reference, and the update-sequence
  array's offset, count and array bounds.
- Verify the update-sequence fixups: every sector trailer the array covers must
  hold the array's sequence number. A mismatch keeps the record's header facts
  and is reported per record and in the metadata count.
- Report a missing, misplaced or short update-sequence array as unverified
  rather than as a clean record, and a trailing partial record as a byte count.
- Stop at the first record that does not begin with the `FILE` signature and
  name its offset, rather than guessing at the remaining bytes.
- Bound the whole file by `ntfs.mft_max_file_bytes` (launch seed
  `REA_NTFS_MFT_MAX_FILE_BYTES`; default 512 MiB, floor 48 bytes, maximum
  8 GiB). A file above the effective ceiling is a `limit` failure with
  boundary `file-size` and code `ntfs_mft_file_size`. The failure names the
  setting, the effective value, whether it came from the default, the launch
  setting, or a runtime override, and the allowed range.
  `update_analysis_settings` changes it for the next operation.
- Parse only the records' headers and fixups. Attributes, filenames, data
  streams and the `$UsnJrnl:$J` journal are not decoded in this step, so no path,
  file size, file reference correlation or change history is claimed.

## Acceptance

Synthesized fixtures cover a clean record, a failed fixup, a missing update
sequence array, an array shorter than the record's sector count, extension and
directory records, a record whose signature is wrong mid-stream, a trailing
partial record, an undeclared record size, a 4 KiB record, a stream shorter than
one header, bytes without the `FILE` signature, and the file-size ceiling.
Inventory tests cover the root occurrence's metadata and the coverage status
when a fixup fails, and classification tests cover several file names for the
same bytes.

Not covered in this step: real `$MFT` files written by a Windows host, USN
journal records, attribute decoding, and any correlation between the two.
