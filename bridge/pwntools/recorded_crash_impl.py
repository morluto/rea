"""Bounded Linux core evidence via unchanged ELFFile/structs and pwntools ctypes.

No Corefile-selected thread, executable guessing, process lookup or target launch.
"""
import base64
import ctypes
import importlib.metadata
import io
from pathlib import Path
import sys

PROFILE = "pwntools@4.15.0;pyelftools@0.33;unicorn@2.1.2"


class CoreFailure(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def encoded(value):
    return base64.b64encode(value).decode("ascii")


def location(offset, size, limit):
    if not 0 <= offset <= limit or not 0 <= size <= limit - offset:
        raise CoreFailure("format", "Recorded source range exceeds its declared container.")
    return {"offset": hex(offset), "bytes": hex(size)}


def inspect_core(path, cache):
    for package, required in {"pwntools": "4.15.0", "pyelftools": "0.33", "unicorn": "2.1.2"}.items():
        try:
            actual = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError as error:
            raise CoreFailure("unavailable", "Selected Python lacks " + package + " " + required + ".") from error
        if actual != required:
            raise CoreFailure("unsupported", "Expected " + package + " " + required + "; selected Python reports " + actual + ".")
    content = path.read_bytes()
    if len(content) < 16 or content[:4] != b"\x7fELF":
        raise CoreFailure("format", "Selected recording lacks a complete ELF identification.")
    if content[4:6] != b"\x02\x01":
        raise CoreFailure("unsupported-target", "Initial recorded-core profile requires ELF64 little-endian.")
    if len(content) < 64:
        raise CoreFailure("format", "Selected ELF64 core header is truncated.")
    if int.from_bytes(content[16:18], "little") != 4 or int.from_bytes(content[18:20], "little") != 62:
        raise CoreFailure("unsupported-target", "Initial recorded-core profile requires x86-64 ET_CORE.")
    from elftools.common.exceptions import ELFError
    from elftools.common.utils import struct_parse
    from elftools.elf.elffile import ELFFile
    from pwnlib.elf.datatypes import elf_prstatus_amd64, elf_siginfo_64, user_regs_struct_amd64
    try:
        image = ELFFile(io.BytesIO(content))
        header = image.header
        count = image.num_segments()
        if count and header.e_phentsize < image.structs.Elf_Phdr.sizeof():
            raise CoreFailure("format", "Program-header entry is shorter than the required ELF64 structure.")
        location(header.e_phoff, count * header.e_phentsize, len(content))
        segments, notes, padding, threads, signals = [], [], [], [], []
        for segment_index, segment in enumerate(image.iter_segments()):
            h = segment.header
            backing = h.p_type != "PT_NULL" and h.p_filesz > 0
            if backing:
                location(h.p_offset, h.p_filesz, len(content))
            if h.p_type == "PT_LOAD" and h.p_filesz > h.p_memsz:
                raise CoreFailure("format", "Recorded PT_LOAD file bytes exceed memory size.")
            segments.append({"index": segment_index, "type": h.p_type,
                             "header_location": location(header.e_phoff + segment_index * header.e_phentsize, header.e_phentsize, len(content)),
                             "offset": hex(h.p_offset), "file_size": hex(h.p_filesz), "memory_size": hex(h.p_memsz),
                             "virtual_address": hex(h.p_vaddr), "physical_address": hex(h.p_paddr), "alignment": hex(h.p_align), "flags": hex(h.p_flags), "file_backing": "file" if backing else "none"})
            if h.p_type != "PT_NOTE" or h.p_filesz == 0:
                continue
            position, end = h.p_offset, h.p_offset + h.p_filesz
            header_size = image.structs.Elf_Nhdr.sizeof()
            while position < end:
                if end - position < header_size:
                    raw = content[position:end]
                    if any(raw):
                        raise CoreFailure("format", "Nonzero trailing note bytes lack a complete note header.")
                    padding.append({"segment_index": segment_index, "location": location(position, len(raw), end), "bytes_base64": encoded(raw)})
                    break
                note = struct_parse(image.structs.Elf_Nhdr, image.stream, stream_pos=position)
                owner_start = position + header_size
                descriptor_start = owner_start + ((note.n_namesz + 3) // 4) * 4
                note_end = descriptor_start + ((note.n_descsz + 3) // 4) * 4
                location(position, note_end - position, end)
                owner = content[owner_start:owner_start + note.n_namesz]
                if owner and b"\0" not in owner:
                    raise CoreFailure("format", "Declared note owner has no NUL terminator.")
                display = owner.split(b"\0", 1)[0].decode("utf-8", "replace") if owner else None
                descriptor = content[descriptor_start:descriptor_start + note.n_descsz]
                note_index = len(notes)
                notes.append({"index": note_index, "segment_index": segment_index, "type": note.n_type,
                              "location": location(position, note_end - position, end),
                              "owner_location": location(owner_start, len(owner), end), "owner_bytes_base64": encoded(owner), "owner_display": display,
                              "descriptor_location": location(descriptor_start, len(descriptor), end), "descriptor_bytes_base64": encoded(descriptor)})
                position = note_end
                # Only the initial Linux CORE ABI is interpreted. Other owners retain exact bytes.
                if owner != b"CORE\0":
                    continue
                if note.n_type == "NT_PRSTATUS":
                    if len(descriptor) < ctypes.sizeof(elf_prstatus_amd64):
                        raise CoreFailure("format", "Linux amd64 NT_PRSTATUS descriptor is truncated.")
                    status = elf_prstatus_amd64.from_buffer_copy(descriptor)
                    registers = []
                    for name, kind in user_regs_struct_amd64._fields_:
                        relative = elf_prstatus_amd64.pr_reg.offset + getattr(user_regs_struct_amd64, name).offset
                        registers.append({"name": name, "value": hex(getattr(status.pr_reg, name)), "location": location(descriptor_start + relative, ctypes.sizeof(kind), end)})
                    threads.append({"note_index": note_index, "historical_pid": ctypes.c_int32(status.pr_pid).value, "recorded_current_signal": status.pr_cursig, "registers": registers})
                elif note.n_type == "NT_SIGINFO":
                    if len(descriptor) < ctypes.sizeof(elf_siginfo_64):
                        raise CoreFailure("format", "Linux amd64 NT_SIGINFO descriptor is truncated.")
                    signal = elf_siginfo_64.from_buffer_copy(descriptor)
                    number = ctypes.c_int32(signal.si_signo).value
                    code = ctypes.c_int32(signal.si_code).value
                    known = number == 11 and code in (1, 2)
                    signals.append({"note_index": note_index, "number": number, "code": code, "errno": ctypes.c_int32(signal.si_errno).value,
                                    "fault_address": hex(signal.sigfault_addr) if known else None,
                                    "fault_address_meaning": "recorded-sigsegv-address" if known else "unknown", "thread_association": "unknown"})
        return {"format": "elf-core", "architecture": "x86_64-little-endian", "target_execution": "not-performed", "live_process_identity": "unknown",
                "segments": segments, "notes": notes, "note_padding": padding, "threads": threads, "signals": signals,
                "note_interpretation_completeness": "unknown",
                "limitations": ["Historical PID and signal values are recorded metadata, not current process identity or attach authority.",
                                "Only exact Linux CORE NT_PRSTATUS/NT_SIGINFO owners are interpreted; every descriptor and owner retains original bytes. Other note semantics remain unknown.",
                                "NT_SIGINFO thread association is unknown. Only SIGSEGV SEGV_MAPERR/SEGV_ACCERR initially establish a fault-address union meaning.",
                                "PT_LOAD file bytes are recorded bytes. Undumped memory and current executable/library identity remain unknown; no current host file is resolved from a recorded pathname.",
                                "Missing notes/registers/signals do not establish their absence at the original crash. Full unwinding, executable pairing and live control are not provided."]}
    except CoreFailure:
        raise
    except (ELFError, ValueError, AssertionError, IndexError) as error:
        raise CoreFailure("format", "Recorded core failed unchanged upstream structural parsing: " + str(error)) from error


if __name__ == "__main__":
    runtime_path = Path(__file__).with_name("decoder_runtime.py")
    runtime = {"__file__": str(runtime_path), "__name__": "rea_decoder_runtime"}
    exec(compile(runtime_path.read_bytes(), str(runtime_path), "exec"), runtime)
    runtime["main"](sys.argv[-1], inspect_core, CoreFailure, PROFILE)
