"""Source-owned mutations built with the same unchanged upstream ELF/ABI structures."""
import ctypes
import io
import json
from pathlib import Path
import sys
from elftools.elf.elffile import ELFFile
from elftools.construct import Container
from pwnlib.elf.datatypes import elf_prstatus_amd64

source, directory, sentinel = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
original = source.read_bytes()
image = ELFFile(io.BytesIO(original))
segments = list(image.iter_segments())
notes = [note for segment in segments if segment.header.p_type == "PT_NOTE" for note in segment.iter_notes()]
status = next(note for note in notes if note.n_name == "CORE" and note.n_type == "NT_PRSTATUS")
descriptor_start = lambda note: note.n_offset + image.structs.Elf_Nhdr.sizeof() + ((note.n_namesz + 3) // 4) * 4
files = {}


def save(name, content):
    path = directory / (name + ".core")
    path.write_bytes(content)
    files[name] = str(path)


def note_header(content, note, **changes):
    header = dict(note)
    header.update(changes)
    encoded = image.structs.Elf_Nhdr.build(Container(**header))
    content[note.n_offset:note.n_offset + len(encoded)] = encoded


save("truncated-header", original[:32])
content = bytearray(original)
note_header(content, status, n_descsz=1)
save("truncated-status", content)
content = bytearray(original)
note_header(content, status, n_namesz=len(original))
save("truncated-owner", content)
content = bytearray(original)
content[status.n_offset + image.structs.Elf_Nhdr.sizeof()] = 255
save("opaque-owner", content)
content = bytearray(original)
for note in notes:
    if note.n_type == "NT_SIGINFO":
        note_header(content, note, n_type=0x7ffeff)
save("unknown-signals", content)
content = bytearray(original)
for index, segment in enumerate(segments):
    if segment.header.p_type == "PT_NOTE":
        header = dict(segment.header, p_type="PT_NULL")
        encoded = image.structs.Elf_Phdr.build(Container(**header))
        start = image.header.e_phoff + index * image.header.e_phentsize
        content[start:start + len(encoded)] = encoded
save("missing-notes", content)
content = bytearray(original)
start = descriptor_start(status) + elf_prstatus_amd64.pr_pid.offset
content[start:start + ctypes.sizeof(ctypes.c_uint32)] = (0xfffffffe).to_bytes(4, "little")
save("negative-pid", content)
content = bytearray(original)
content[start:start + ctypes.sizeof(ctypes.c_uint32)] = sentinel.to_bytes(4, "little")
for note in notes:
    if note.n_name == "CORE" and note.n_type == "NT_PRPSINFO":
        # Build with unchanged pyelftools; no hard-coded PID offset or host file resolution.
        raw = dict(note.n_desc, pr_pid=sentinel)
        encoded = image.structs.Elf_Prpsinfo.build(Container(**raw))
        offset = descriptor_start(note)
        content[offset:offset + len(encoded)] = encoded
save("historical-pid-collision", content)
print(json.dumps(files))
