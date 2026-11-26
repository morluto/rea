import {
  ZIP_CLASSIC_DIRECTORY_LIMITS,
  ZIP_CLASSIC_DISK_OFFSETS,
  ZIP_SINGLE_VOLUME,
  ZIP64_END,
  ZIP64_LOCATOR,
} from "../zipEndOfCentralDirectory.js";
import { ZIP_CENTRAL_HEADER } from "../zip/zipCentralHeader.js";
import { ZIP_EXTRA_FIELD } from "../zip/zipExtraFields.js";

/**
 * The exported module's zip and gzip readers: the central directory read a
 * record at a time, entries read in bounded chunks, a gzip file's document
 * within an entry's limits, and each one's view by the rules a file's follow,
 * with REA's limits and wording. Part of the module's helpers.
 */
export const PYTHON_ZIP_HELPERS = String.raw`
ZIP_READ_CHUNK = 64 * 1024
#: Small, since the end of each gzip member copies what is left of the piece it was read from.
GZIP_READ_CHUNK = 4 * 1024
ZIP_END = b"PK\x05\x06"
ZIP_CENTRAL_LAYOUT = ${JSON.stringify(ZIP_CENTRAL_HEADER)}
ZIP_CENTRAL = ZIP_CENTRAL_LAYOUT["signature"].to_bytes(4, "little")
ZIP64_LOCATOR = b"PK\x06\x07"
ZIP64_END = b"PK\x06\x06"
ZIP64_END_LAYOUT = ${JSON.stringify(ZIP64_END)}
ZIP64_LOCATOR_LAYOUT = ${JSON.stringify(ZIP64_LOCATOR)}
ZIP_CLASSIC_DIRECTORY_LIMITS = ${JSON.stringify(ZIP_CLASSIC_DIRECTORY_LIMITS)}
ZIP_CLASSIC_DISK_OFFSETS = ${JSON.stringify(Object.values(ZIP_CLASSIC_DISK_OFFSETS))}
ZIP_SINGLE_VOLUME = ${JSON.stringify(ZIP_SINGLE_VOLUME)}
ZIP_EXTRA_FIELD = ${JSON.stringify(ZIP_EXTRA_FIELD)}
#: Formats an archive entry may have whose reader needs a tool, a worker or another archive opened.
NOT_READ_INSIDE = ((SQLITE_HEADER, "sqlite", "a SQLite database"), (GVDB_HEADER, "dconf", "a dconf database"))


def _entry_view(name: str, data: bytes) -> dict:
    """An archive entry's format and view by the rules a file's follow; a database or an archive inside is not
    read."""
    for header, form, inside in NOT_READ_INSIDE:
        if data.startswith(header):
            return {"format": form, "view": None, "error": f"{inside} inside an archive is not read"}
    if _is_zip(data):
        return {"format": "zip", "view": None, "error": "an archive inside an archive is not read"}
    return _bytes_view(name, data)


def _zip_refusal(info, spent: int):
    """Why an entry is not read, checked in REA's order, or None; spent is the archive's bytes read so far."""
    if info.flag_bits & 0x1:
        return "encrypted, so it is not read"
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        return f"compressed with method {info.compress_type}, which the view does not read"
    if info.file_size > MAX_ZIP_ENTRY_BYTES:
        return f"larger than the {_view_byte_limit(MAX_ZIP_ENTRY_BYTES)} an entry's view reads"
    if info.file_size > MAX_ZIP_RATIO * info.compress_size:
        return f"expands more than {MAX_ZIP_RATIO} times, so it is not read"
    if spent + info.file_size > MAX_ZIP_BYTES:
        return f"past the {_view_byte_limit(MAX_ZIP_BYTES)} read from one archive"
    return None


def _entry_bytes(archive, info):
    """An entry's uncompressed bytes, or None when they fail its CRC-32 or are not exactly its declared size. Reading
    stops one byte past that size, which data past a short declared size fills, and asks for a bounded chunk at a
    time, which bounds what the decompressor expands per call, so a forged small size holds no more than that."""
    probe = copy.copy(info)
    probe.file_size = info.file_size + 1
    data = bytearray()
    try:
        with archive.open(probe) as member:
            while len(data) <= info.file_size:
                chunk = member.read(min(probe.file_size - len(data), ZIP_READ_CHUNK))
                if not chunk:
                    break
                data += chunk
    except (zipfile.BadZipFile, zlib.error, EOFError, OSError, ValueError):
        return None
    return data if len(data) == info.file_size else None


def _zip_entry(archive, info, refusal, name):
    """One entry of a zip view: its name, size and digest, and its own format and view, or why it was not read."""
    entry = {"name": name, "size": info.file_size, "sha256": None, "format": None, "view": None,
             "view_error": refusal}
    if refusal is not None:
        return entry
    data = _entry_bytes(archive, info)
    if data is None:
        return {**entry, "view_error": "its compressed data is damaged"}
    view = _entry_view(name, data)
    return {**entry, "sha256": hashlib.sha256(data).hexdigest(), "format": view["format"],
            "view": view.get("view"), "view_error": view.get("error")}


def _zip64_directory_record(file, record: int, locator: int):
    """Read the fixed fields only, after the entire declared record fits before the locator."""
    fixed = ZIP64_END_LAYOUT["fixedBytes"]
    prefix = ZIP64_END_LAYOUT["sizePrefixBytes"]
    if record < 0 or record + fixed > locator:
        return None
    file.seek(record)
    header = file.read(fixed)
    if len(header) != fixed or header[:4] != ZIP64_END:
        return None
    body = struct.unpack_from("<Q", header, ZIP64_END_LAYOUT["sizeOffset"])[0]
    if body < fixed - prefix or record + prefix + body != locator:
        return None
    return header


def _zip_end(file, size: int):
    """Read the classic end and any declared Zip64 frame from the single supplied volume."""
    window = min(size, 22 + 0xFFFF)
    file.seek(size - window)
    tail = file.read(window)
    at = tail.rfind(ZIP_END, 0, len(tail) - 18)
    while at >= 0 and at + 22 + int.from_bytes(tail[at + 20:at + 22], "little") != len(tail):
        at = tail.rfind(ZIP_END, 0, at + 3)
    if at < 0:
        return None
    entries_on_disk, total, length, offset = struct.unpack_from("<HHII", tail, at + 8)
    classic_disks = [struct.unpack_from("<H", tail, at + field)[0] for field in ZIP_CLASSIC_DISK_OFFSETS]
    end = size - window + at
    classic = ((end, length, offset, total)
               if entries_on_disk == total and all(disk in ZIP_SINGLE_VOLUME["classic"] for disk in classic_disks)
               else None)
    locator_at = end - ZIP64_LOCATOR_LAYOUT["bytes"]
    if locator_at < 0:
        return classic
    file.seek(locator_at)
    locator = file.read(ZIP64_LOCATOR_LAYOUT["bytes"])
    if len(locator) != ZIP64_LOCATOR_LAYOUT["bytes"] or locator[:4] != ZIP64_LOCATOR:
        return classic
    declared = struct.unpack_from("<Q", locator, ZIP64_LOCATOR_LAYOUT["recordOffset"])[0]
    fallback = locator_at - ZIP64_END_LAYOUT["fixedBytes"]
    # The fixed fallback preserves archives whose offsets omit prepended bytes.
    for record in (declared, fallback):
        zip64 = _zip64_directory_record(file, record, locator_at)
        if zip64 is None:
            continue
        if (any(disk not in ZIP_SINGLE_VOLUME["zip64Classic"] for disk in classic_disks)
                or any(struct.unpack_from("<I", locator, field)[0] != value
                       for field, value in ZIP_SINGLE_VOLUME["zip64Locator"])
                or any(struct.unpack_from("<I", zip64, field)[0] != value
                       for field, value in ZIP_SINGLE_VOLUME["zip64End"])):
            return None
        length = struct.unpack_from("<Q", zip64, ZIP64_END_LAYOUT["directorySizeOffset"])[0]
        offset = struct.unpack_from("<Q", zip64, ZIP64_END_LAYOUT["directoryOffset"])[0]
        entries_on_disk = struct.unpack_from("<Q", zip64, ZIP64_END_LAYOUT["entriesOnDiskOffset"])[0]
        total = struct.unpack_from("<Q", zip64, ZIP64_END_LAYOUT["totalEntriesOffset"])[0]
        return (record, length, offset, total) if entries_on_disk == total else None
    limits = ZIP_CLASSIC_DIRECTORY_LIMITS
    if total == limits["count"] or length == limits["size"] or offset == limits["offset"]:
        return None
    return classic


def _zip_extras(extra: bytes):
    """Check all framed fields before selection and return the last Unicode Path and the other original bytes."""
    at, copied, selected, kept = 0, 0, None, None
    header = ZIP_EXTRA_FIELD["headerBytes"]
    while at + header <= len(extra):
        payload = at + header
        size = struct.unpack_from("<H", extra, at + ZIP_EXTRA_FIELD["sizeOffset"])[0]
        end = payload + size
        if end > len(extra):
            raise zipfile.BadZipFile("Corrupt extra field")
        kind = struct.unpack_from("<H", extra, at + ZIP_EXTRA_FIELD["idOffset"])[0]
        if kind == ZIP_EXTRA_FIELD["unicodePath"]:
            selected = (payload, end)
            if kept is None:
                kept = bytearray()
            kept += extra[copied:at]
            copied = end
        at = end
    if selected is None:
        return None, extra
    kept += extra[copied:]
    return extra[selected[0]:selected[1]], kept


def _zip_unicode_path(raw: bytes, flags: int, data):
    """Use the last Info-ZIP Unicode Path only when it binds to the stored name, as zip.js does."""
    usable = (data is not None and len(data) >= 5 and data[0] == 1 and not flags & 0x800
              and int.from_bytes(data[1:5], "little") == zlib.crc32(raw))
    return data[5:] if usable else None


def _zip_name(raw: bytes, flags: int, unicode_path):
    """The exact REA name, shared by directory classification and the retained entry view."""
    if flags & 0x800:
        return raw.decode("utf-8")
    return raw.decode("cp437") if unicode_path is None else unicode_path.decode("utf-8")


def _zip_kept_record(fixed: bytes, raw: bytes, extra, comment: bytes):
    """Remove already-interpreted Unicode claims from the bounded decoder copy. zipfile otherwise interprets each
    occurrence, retaining an earlier valid name or rejecting invalid UTF-8 that zip.js already superseded.
    All other fields, comments and the original artifact bytes remain unchanged."""
    header = bytearray(fixed)
    struct.pack_into("<H", header, ZIP_CENTRAL_LAYOUT["extraBytesOffset"], len(extra))
    return header + raw + extra + comment


def _zip_directory(file, size: int, keep: int):
    """An archive's central directory read a record at a time, keeping the first file entries' records, as many as keep allows, and
    counting the rest, as REA reads it: (start, declared offset, records, count, names), or None when it cannot be read.
    Directories are told apart as zip.js tells them: a final slash, a Unix directory mode, or the MS-DOS attribute."""
    located = _zip_end(file, size)
    if located is None:
        return None
    end, length, declared, total = located
    start = end - length
    if start < 0:
        return None
    file.seek(start)
    records, names, count, seen, at = [], [], 0, 0, start
    fixed_bytes = ZIP_CENTRAL_LAYOUT["bytes"]
    while at < end:
        if at + fixed_bytes > end:
            return None
        fixed = file.read(fixed_bytes)
        if len(fixed) < fixed_bytes or fixed[:4] != ZIP_CENTRAL:
            return None
        made_by, flags = struct.unpack_from("<H2xH", fixed, 4)
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", fixed, ZIP_CENTRAL_LAYOUT["nameBytesOffset"])
        external = struct.unpack_from("<I", fixed, 38)[0]
        variable_bytes = name_length + extra_length + comment_length
        at += fixed_bytes + variable_bytes
        if at > end:
            return None
        rest = file.read(variable_bytes)
        if len(rest) < variable_bytes:
            return None
        seen += 1
        extra_end = name_length + extra_length
        raw = rest[:name_length]
        selected, extra = _zip_extras(rest[name_length:extra_end])
        name = _zip_name(raw, flags, _zip_unicode_path(raw, flags, selected))
        if not (name.endswith("/") or (external >> 16) & 0o170000 == 0o040000 or (made_by >> 8 == 0 and external & 0x10)):
            count += 1
            if len(records) < keep:
                records.append(_zip_kept_record(fixed, raw, extra, rest[extra_end:]))
                names.append(name)
    return (start, declared, records, count, names) if seen == total else None


class _BoundedArchive(io.RawIOBase):
    """An archive as zipfile reads it: its entries in place, then a directory of the kept records alone and end
    records for them, so zipfile parses no more records than the view lists."""

    def __init__(self, file, start: int, tail: bytes) -> None:
        super().__init__()
        self._file, self._start, self._tail, self._at = file, start, tail, 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._at

    def seek(self, offset: int, whence: int = 0) -> int:
        self._at = offset + (0, self._at, self._start + len(self._tail))[whence]
        return self._at

    def readinto(self, buffer) -> int:
        view = memoryview(buffer)
        if self._at < self._start:
            self._file.seek(self._at)
            count = self._file.readinto(view[:self._start - self._at])
        else:
            chunk = self._tail[self._at - self._start:self._at - self._start + len(view)]
            count = len(chunk)
            view[:count] = chunk
        self._at += count
        return count


def _zip(file, size: int) -> dict:
    """A zip archive's file entries in archive order, up to REA's entry, size, ratio and archive limits; nothing is
    extracted to disk, no archive inside is opened, and zipfile is shown only the directory records listed."""
    entries, spent = [], 0
    try:
        directory = _zip_directory(file, size, MAX_ZIP_ENTRIES)
        if directory is None:
            raise zipfile.BadZipFile("no readable central directory")
        start, declared, records, count, names = directory
        kept, retained = b"".join(records), len(records)
        limit = ZIP_CLASSIC_DIRECTORY_LIMITS
        offset = declared if declared <= limit["offset"] else start
        classic_count = min(retained, limit["count"])
        # zipfile follows a Zip64 locator signature wherever one sits before the end record, including in
        # a kept record's comment. Give it real Zip64 records with the exact selected directory facts.
        tail = (kept
                + struct.pack("<4sQ2H2I4Q", ZIP64_END, 44, 45, 45, 0, 0, retained, retained, len(kept), offset)
                + struct.pack("<4sIQI", ZIP64_LOCATOR, 0, offset + len(kept), 1)
                + struct.pack("<4s4H2IH", ZIP_END, 0, 0, classic_count, classic_count,
                              min(len(kept), limit["size"]), min(offset, limit["offset"]), 0))
        with zipfile.ZipFile(_BoundedArchive(file, start, tail)) as archive:
            infos = archive.infolist()
            if len(infos) != len(names):
                raise zipfile.BadZipFile("retained member count differs from decoded member count")
            for info, name in zip(infos, names):
                refusal = _zip_refusal(info, spent)
                spent += info.file_size if refusal is None else 0
                entries.append(_zip_entry(archive, info, refusal, name))
    except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, OSError, ValueError, struct.error):
        return {"format": "zip", "view": None, "error": "not a readable zip archive"}
    view = {"entries": entries, "entry_count": count, "truncated": count > len(entries)}
    return {"format": "zip", "view": view, "truncated": view["truncated"]}


def _gunzip(data: bytes, limit: int):
    """A gzip stream's document, its members joined as REA joins them, or None once it passes limit bytes, where
    decompressing stops: data after a member that starts with a zero byte is padding and ends the stream. It is read
    a piece at a time, so a member's end carries over only the rest of its piece. Raises zlib.error or EOFError when
    the stream is damaged or cut short."""
    document, member, rest, at = bytearray(), zlib.decompressobj(16 + zlib.MAX_WBITS), b"", 0
    while True:
        if not rest:
            if at >= len(data):
                raise EOFError("the gzip stream is cut short")
            rest, at = data[at:at + GZIP_READ_CHUNK], at + GZIP_READ_CHUNK
        document += member.decompress(rest, limit + 1 - len(document))
        if len(document) > limit:
            return None
        if not member.eof:
            rest = member.unconsumed_tail
            continue
        rest = member.unused_data
        if not rest and at < len(data):
            rest, at = data[at:at + GZIP_READ_CHUNK], at + GZIP_READ_CHUNK
        if not rest or rest[0] == 0:
            return bytes(document)
        member = zlib.decompressobj(16 + zlib.MAX_WBITS)


def _gzip(name: str, data: bytes) -> dict:
    """A gzip file's view: its document's, decompressed within an archive entry's size and ratio limits and read by
    the rules a file's follow; a database inside is not read."""
    compressed = {"format": None, "compression": "gzip", "view": None}
    try:
        document = _gunzip(data, min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_RATIO * len(data)))
    except (zlib.error, EOFError):
        return {**compressed, "error": "not a readable gzip stream"}
    if document is None:
        return {**compressed, "error": f"expands more than {MAX_ZIP_RATIO} times, so it is not read"
                if MAX_ZIP_RATIO * len(data) < MAX_ZIP_ENTRY_BYTES
                else f"larger than the {_view_byte_limit(MAX_ZIP_ENTRY_BYTES)} a compressed document's view reads"}
    for header, form, inside in NOT_READ_INSIDE:
        if document.startswith(header):
            return {**compressed, "format": form, "error": f"{inside} inside a gzip file is not read"}
    view = _zip(io.BytesIO(document), len(document)) if _is_zip(document) else _bytes_view(name, document)
    return {**view, "compression": "gzip"}
`;
