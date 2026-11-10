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
ZIP_CENTRAL = b"PK\x01\x02"
ZIP64_LOCATOR = b"PK\x06\x07"
ZIP64_END = b"PK\x06\x06"
#: Formats an archive entry may have whose reader needs a tool, a worker or another archive opened.
NOT_READ_INSIDE = ((SQLITE_HEADER, "sqlite", "a SQLite database"), (GVDB_HEADER, "dconf", "a dconf database"),
                   (ZIP_HEADER, "zip", "an archive"))


def _entry_view(name: str, data: bytes) -> dict:
    """An archive entry's format and view by the rules a file's follow; a database or an archive inside is not
    read."""
    for header, form, inside in NOT_READ_INSIDE:
        if data.startswith(header):
            return {"format": form, "view": None, "error": f"{inside} inside an archive is not read"}
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


def _zip_entry(archive, info, refusal):
    """One entry of a zip view: its name, size and digest, and its own format and view, or why it was not read."""
    # zipfile can override a UTF-8-flagged name with a Unicode Path extra field.
    # REA's ZIP reader gives the explicitly UTF-8 stored name precedence.
    name = info.orig_filename if info.flag_bits & 0x800 else info.filename
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


def _zip_end(file, size: int):
    """Where an archive's central directory ends, how long it is and the offset it declares, from the last end
    record whose comment reaches the end of the file and, when a Zip64 locator precedes it whatever that record
    holds, the Zip64 one just before the locator; None without an end record, or when sentinels defer to a
    Zip64 record that is missing."""
    window = min(size, 22 + 0xFFFF)
    file.seek(size - window)
    tail = file.read(window)
    at = tail.rfind(ZIP_END, 0, len(tail) - 18)
    while at >= 0 and at + 22 + int.from_bytes(tail[at + 20:at + 22], "little") != len(tail):
        at = tail.rfind(ZIP_END, 0, at + 3)
    if at < 0:
        return None
    total, length, offset = struct.unpack_from("<HII", tail, at + 10)
    end = size - window + at
    record = end - 20 - 56
    if record < 0:
        return end, length, offset
    file.seek(end - 20)
    if file.read(4) != ZIP64_LOCATOR:
        return end, length, offset
    file.seek(record)
    zip64 = file.read(56)
    if len(zip64) == 56 and zip64[:4] == ZIP64_END:
        length, offset = struct.unpack_from("<QQ", zip64, 40)
        return record, length, offset
    if total == 0xFFFF or 0xFFFFFFFF in (length, offset):
        return None
    return end, length, offset


def _zip_unicode_path(raw: bytes, flags: int, extra: bytes):
    """An Info-ZIP Unicode Path when zip.js uses it: version 1, no UTF-8 flag, and the CRC-32 of the stored name."""
    at = 0
    while at + 4 <= len(extra):
        kind, length = struct.unpack_from("<HH", extra, at)
        if kind == 0x7075:
            data = extra[at + 4:at + 4 + length]
            usable = (length >= 5 and len(data) == length and data[0] == 1 and not flags & 0x800
                      and int.from_bytes(data[1:5], "little") == zlib.crc32(raw))
            return data[5:] if usable else None
        at += 4 + length
    return None


def _zip_ends_in_slash(raw: bytes, flags: int, extra: bytes):
    """Whether an entry's name, as REA decodes it, ends in a slash; None when it must be UTF-8 and is not."""
    utf8 = _zip_unicode_path(raw, flags, extra)
    if utf8 is None and flags & 0x800:
        utf8 = raw
    if utf8 is None:
        return raw.endswith(b"/")
    try:
        return utf8.decode("utf-8").endswith("/")
    except UnicodeDecodeError:
        return None


def _zip_directory(file, size: int, keep: int):
    """An archive's central directory read a record at a time, keeping the first file entries' records, as many as keep allows, and
    counting the rest, as REA reads it: (start, declared offset, records, count), or None when it cannot be read.
    Directories are told apart as zip.js tells them: a final slash, a Unix directory mode, or the MS-DOS attribute."""
    located = _zip_end(file, size)
    if located is None:
        return None
    end, length, declared = located
    start = end - length
    if start < 0:
        return None
    file.seek(start)
    records, count, at = [], 0, start
    while at < end:
        fixed = file.read(46)
        if at + 46 > end or len(fixed) < 46 or fixed[:4] != ZIP_CENTRAL:
            return None
        made_by, flags = struct.unpack_from("<H2xH", fixed, 4)
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", fixed, 28)
        external = struct.unpack_from("<I", fixed, 38)[0]
        rest = file.read(name_length + extra_length + comment_length)
        at += 46 + name_length + extra_length + comment_length
        if len(rest) < name_length + extra_length + comment_length or at > end:
            return None
        slash = _zip_ends_in_slash(rest[:name_length], flags, rest[name_length:name_length + extra_length])
        if slash is None:
            return None
        if not (slash or (external >> 16) & 0o170000 == 0o040000 or (made_by >> 8 == 0 and external & 0x10)):
            count += 1
            if len(records) < keep:
                records.append(fixed + rest)
    return start, declared, records, count


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
        start, declared, records, count = directory
        kept = b"".join(records)
        offset = declared if declared <= 0xFFFFFFFF else start
        # zipfile follows a Zip64 locator signature wherever one sits before the end record, and the kept records
        # may end in those bytes, so a real Zip64 end record and locator for them come first.
        tail = (kept
                + struct.pack("<4sQ2H2I4Q", ZIP64_END, 44, 45, 45, 0, 0, len(records), len(records), len(kept), offset)
                + struct.pack("<4sIQI", ZIP64_LOCATOR, 0, offset + len(kept), 1)
                + struct.pack("<4s4H2IH", ZIP_END, 0, 0, len(records), len(records), len(kept), offset, 0))
        with zipfile.ZipFile(_BoundedArchive(file, start, tail)) as archive:
            for info in archive.infolist():
                refusal = _zip_refusal(info, spent)
                spent += info.file_size if refusal is None else 0
                entries.append(_zip_entry(archive, info, refusal))
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
        if form != "zip" and document.startswith(header):
            return {**compressed, "format": form, "error": f"{inside} inside a gzip file is not read"}
    view = _zip(io.BytesIO(document), len(document)) if document.startswith(ZIP_HEADER) else _bytes_view(name, document)
    return {**view, "compression": "gzip"}
`;
