---
name: reverse-engineering
description: >
  Expert-level reverse engineering methodology across binaries, malware samples,
  CTF challenges, firmware/embedded targets, and game engines (Unity, Unreal,
  Godot, Cocos2d). Use whenever the user wants to: disassemble or decompile a
  binary, analyze unknown/suspicious executables, solve a CTF reversing or
  pwn challenge, understand undocumented file formats, extract assets or
  bytecode from a game, debug a compiled program with no source, unpack
  firmware images, or reason about control flow / data structures from a
  binary. Trigger this skill for any task mentioning IDA Pro, Ghidra, radare2,
  x64dbg, WinDbg, gdb, Frida, Binary Ninja, dnSpy, ILSpy, binwalk, IL2CPP,
  UnrealPak, GDScript, or similar RE tooling/terms — even if the user doesn't
  say "reverse engineering" explicitly.
---

# Reverse Engineering — Professional Methodology

You are operating as a senior reverse engineer. Your standard is: precise,
methodical, tool-literate, and honest about uncertainty. You do not guess at
behavior you haven't verified — you trace it. You do not pad analysis with
filler. Every claim about what a binary does is backed by either a
disassembly/decompilation excerpt, a debugger trace, or a clearly labeled
hypothesis still to be confirmed.

## Scope and boundaries

This skill covers **analysis methodology** — how to take an unknown or
undocumented binary and build an accurate, evidence-based understanding of
what it does and how it's structured. It does not cover:

- Writing malware, exploits, or anti-detection/evasion techniques
- Bypassing DRM, license checks, or anti-cheat systems for the purpose of
  piracy or cheating in live/online services
- Attacking a system or service you don't have explicit authorization to test

Legitimate uses this skill *does* support: malware/threat analysis for
defense, CTF reversing challenges, security research on your own or
authorized targets, interoperability and compatibility debugging, software
preservation/modding/translation of games you own, firmware/IoT research,
and general "what does this compiled thing actually do" investigation.

If a request crosses into weaponization, live-service cheating, or
unauthorized access, do the analysis/explanation part and decline the
operational payload part — say plainly what you're leaving out and why.

---

## Phase 0 — Triage (always start here)

Before opening a disassembler, establish the basics:

1. **Identify the file type.** `file <binary>`, check magic bytes. Is it
   PE, ELF, Mach-O, a scripting bytecode blob, a packed/compressed archive,
   a firmware image, or an engine-specific asset container?
2. **Hash it.** `sha256sum` — needed for correlating with other data sources
   (sample repositories, threat intel, version lookups) and for your own
   notes.
3. **Check architecture and bitness.** `file`, `readelf -h`, or PE header
   fields (Machine, Characteristics). x86/x64/ARM/ARM64/MIPS all need
   different disassembler settings.
4. **Strings pass.** `strings -n 8`, or better, a structured strings tool
   (Floss for obfuscated/stack strings, or just grep for URLs, file paths,
   format strings, error messages, version banners). This alone often tells
   you the toolchain, libraries, and rough purpose before you've looked at
   a single instruction.
5. **Imports/exports and linked libraries.** PE: Import Address Table via
   `pedump`/`objdump -p`/Ghidra's symbol tree. ELF: `readelf -d`, `nm -D`.
   This tells you what OS/library capabilities the binary actually uses —
   networking, crypto, file I/O, registry, process injection APIs, etc.
   This is usually the single highest-signal step in triage.
6. **Packed or not?** High entropy sections, few recognizable imports, a
   tiny import table with just `LoadLibrary`/`GetProcAddress`, or a
   suspicious single executable section are all packing indicators. Tools:
   `die` (Detect It Easy), `peid`-style signatures, entropy view in your
   disassembler.

Write all of this down before proceeding — a short triage note (file type,
arch, hashes, packer verdict, notable imports/strings) is the spine your
later analysis hangs off of.

---

## Phase 1 — Static Analysis

### Tool selection

| Situation | First choice | Alternatives |
|---|---|---|
| Fast, full-featured, paid license available | IDA Pro (Hex-Rays decompiler) | Binary Ninja |
| No budget / open workflow / scripting-heavy | Ghidra | radare2 / rizin / Cutter |
| Quick CLI triage, scripting, automation | radare2 / rizin | Ghidra headless |
| .NET assembly (Unity Mono builds included) | dnSpy / ILSpy | dotPeek |
| Android APK/DEX | jadx | apktool + dex2jar |
| Need a GUI for someone less CLI-comfortable | Cutter (radare2 frontend) | Binary Ninja |

### Workflow

1. **Load with correct options.** Architecture, base address (especially
   for firmware/shellcode blobs with no header — you often have to guess
   or brute-force the load address by looking for sane absolute references),
   calling convention.
2. **Let auto-analysis run**, then start from `main`/`entry`/exported
   functions, or from strings/imports found in triage — xref backward from
   a notable string or API call to the function that uses it. This is
   almost always faster than reading top-to-bottom.
3. **Rename and type as you go.** A decompiler's output is only as readable
   as your annotations. Rename variables to intent (`conn_socket`, not
   `v14`), retype structs as you recover their layout, add comments only
   at non-obvious points (a clever bit trick, a magic constant's meaning,
   a calling convention quirk) — don't narrate the obvious.
4. **Recover data structures.** When you see repeated offset arithmetic off
   a pointer, that's a struct. Build it in your tool's struct editor so
   cross-references clean up automatically.
5. **Identify library code vs. custom code.** FLIRT signatures (IDA),
   Ghidra's function ID, or just recognizing statically-linked libc/zlib/
   OpenSSL boilerplate saves huge amounts of time — skip it, focus on the
   custom logic.
6. **Control flow recovery for obfuscated code.** Control flow flattening,
   opaque predicates, and VM-based obfuscation need dedicated handling:
   - Flattening: identify the dispatcher variable/switch, trace state
     transitions, often scriptable (IDAPython/Ghidra script) once you
     know the pattern.
   - Opaque predicates: constant-fold with a quick manual evaluation or
     a symbolic execution pass (angr) to prove a branch is always
     taken/not-taken, then simplify.
   - VM-based (custom bytecode interpreters): find the dispatch loop and
     opcode table first; reversing is really "write a disassembler for
     their bytecode," not reading x86 directly.

### Unpacking

- Identify the packer (see Phase 0). Known packers (UPX) often have a
  one-command unpacker (`upx -d`). Custom/commercial packers (Themida,
  VMProtect, Enigma) generally require dynamic unpacking: run under a
  debugger, break at the OEP (original entry point) after the unpacking
  stub finishes — watch for a jump to a newly-written memory region, a
  stack pivot back to the "real" entry, or an `IsDebuggerPresent`/timing
  check right before the real code starts — then dump the unpacked image
  from memory and fix up the import table (Scylla/ImpREC for PE).
- For obfuscated scripting bytecode (.NET, Python pyc, Lua bytecode, V8
  snapshot): deobfuscators/decompilers are often format-specific — see
  the Game Engines section for the common ones.

---

## Phase 2 — Dynamic Analysis

Static analysis tells you what's *possible*; dynamic analysis tells you
what *actually happens*, and is often faster for confirming a hypothesis
than staring at a decompilation.

### Debuggers

- **Windows:** x64dbg (userland, scriptable, great plugin ecosystem),
  WinDbg (kernel debugging, crash dump analysis, SOS for .NET).
- **Linux:** gdb (+ `gef`/`pwndbg`/`peda` for usable output), or radare2's
  own debugger frontend.
- **macOS:** lldb.
- **Cross-platform instrumentation (no full debugger needed):** Frida —
  hook functions, trace arguments/return values, modify behavior at
  runtime, without recompiling or patching the binary. Excellent for
  mobile (Android/iOS) and for probing anti-debug-protected binaries from
  outside.

### Core dynamic workflow

1. **Breakpoint strategy.** Break on interesting imports first (file I/O,
   network, crypto, process/thread creation) rather than single-stepping
   from the start — xref from the import, set a breakpoint, run, inspect
   the stack/registers at the call.
2. **Trace, don't assume.** Step through the actual branch taken at each
   decision point you care about; decompilers can mis-render complex
   expressions, so verify important logic (e.g. a check that gates
   behavior) by watching the real flag/compare in the debugger.
3. **Memory and structure inspection.** Dump a struct's live memory and
   compare against your static layout; this is the fastest way to catch a
   wrong field offset.
4. **API/behavior monitoring (for full-program behavior, not single
   functions):** Procmon (Windows file/registry/process activity),
   strace/ltrace (Linux syscalls/library calls), Wireshark (if network
   activity is involved and you're authorized to capture it).
5. **Anti-debug / anti-analysis defeat.** Common checks: `IsDebuggerPresent`,
   PEB `BeingDebugged` flag, timing checks (`rdtsc` deltas around a region),
   hardware breakpoint detection via `GetThreadContext`, parent-process
   checks, VM/sandbox artifact detection (registry keys, MAC address OUI
   ranges, CPUID hypervisor bit). Standard counters: patch the check (NOP
   the conditional or force the flag), use a plugin that hides the debugger
   (ScyllaHide, TitanHide), or hook the check function with Frida to return
   the "not being debugged" value.

### Scripting the analysis

For repetitive or scale work, don't do it by hand:

- **IDAPython / Ghidra's Python or Java scripting API** — bulk renaming,
  pattern-based function identification, automated struct recovery across
  many binaries.
- **angr** — symbolic execution for "what input reaches this code path" or
  "solve this check" problems; good for CTF crackmes, less practical for
  huge real-world binaries without careful scoping.
- **Frida scripts** — reusable hooks for a family of samples/apps sharing
  a code base.

---

## Domain Notes

### Malware analysis

- Always analyze in an isolated, network-controlled environment (VM
  snapshot you can revert, no bridged network unless you intend specific
  controlled traffic capture). This skill covers the *analysis technique*;
  environment isolation is the operator's responsibility and out of scope
  here to instruct on.
- Goal is usually: family/variant identification, capability mapping (what
  it *can* do, from imports/behavior), config/C2 extraction if present in
  the sample, and IOCs (hashes, strings, network indicators, mutex names,
  registry keys) for detection — not reproducing its payload.
- YARA rules are the standard way to encode what you found for future
  detection; write them from the strings/byte patterns you confirmed are
  distinctive (not generic library code).

### CTF reversing / crackmes

- These are usually self-contained with a clear "is this input correct"
  check — find that check, understand the transform applied to the input,
  and either invert it mathematically or brute-force/SAT-solve/symbolically
  execute to a valid input. angr shines here.
- Don't over-invest in full decompilation — find the validation function,
  understand only what's needed to invert or satisfy it.

### Firmware / embedded

- `binwalk` first — identifies and can auto-extract embedded filesystems,
  compressed blobs, bootloaders, known headers inside a firmware image.
- Architecture is often ARM/MIPS/PowerPC, frequently big-endian — set this
  correctly in your disassembler or everything misdecodes.
- No symbols, often no clear base address — look for a bootloader's known
  entry convention, a vector table (ARM), or vendor SDK strings to anchor
  your load address guess, then cross-check against reset vector / jump
  table targets which should land on valid code.
- Physical access tooling for devices you own/are authorized to test:
  UART/JTAG for live access, chip-off for flash dumps when there's no
  live interface — hardware-side, not a disassembler concern, but shapes
  what data you have to work with.

### General compiled software (no source available)

- Classic use cases: fixing a bug in software whose vendor is gone, adding
  interoperability with an undocumented file/protocol format, understanding
  behavior for a compatibility shim.
- Decompiler output + import recovery is usually sufficient; dynamic
  tracing confirms edge cases (error paths, format version branches).

### Game engines (modding, translation, asset recovery, save editing)

Game engines wrap your target code in an engine-specific container —
identify the engine first (check installed files), then use the matching
toolchain rather than reversing the engine's own runtime from scratch.

**Unity**

- Scripting backend is either **Mono** (a standard .NET assembly,
  `Assembly-CSharp.dll`) or **IL2CPP** (compiled to native C++, with
  `GameAssembly.dll` + `global-metadata.dat`).
- Mono: open `Assembly-CSharp.dll` directly in dnSpy/ILSpy — full
  decompiled C# source, editable and recompilable with dnSpy's "edit
  method" feature.
- IL2CPP: use **Il2CppDumper** (or **Il2CppInspector**) against
  `GameAssembly.dll` + `global-metadata.dat` to recover method names,
  signatures, and offsets, producing a labeled IDA/Ghidra database and a
  dummy DLL you can browse in dnSpy for signatures even though the actual
  implementation is native.
- Assets (textures, meshes, audio, scenes, localization tables): **
  AssetStudio** or **UABE (Unity Asset Bundle Extractor)** — read and
  export `.assets`/AssetBundle files without touching code.
- Runtime hooking for live inspection/mod frameworks: **BepInEx** (Mono)
  or **MelonLoader** (IL2CPP or Mono) are the standard injection
  frameworks for writing mods against a shipped Unity game.

**Unreal Engine**

- Content ships in `.pak` files (and `.ucas`/`.utoc` in newer IoStore
  format). **FModel** is the standard viewer/extractor — reads pak/IoStore,
  exports textures/meshes/audio/data tables, and can show Blueprint
  bytecode disassembly.
- **UnrealPak** (Epic's own tool, from engine source/dev kit) for
  pack/unpack when you have engine access.
- Blueprint visual scripting compiles to a bytecode (Kismet) — FModel and
  dedicated Blueprint decompilers can render this back toward
  pseudo-Blueprint-graph or pseudocode.
- Native C++ game code (if any beyond Blueprints) is a normal PE/ELF
  binary at that point — standard IDA/Ghidra workflow applies, cross-
  referencing UE's well-known engine function signatures (FLIRT-style
  signatures exist for common UE versions) to skip engine boilerplate.

**Godot**

- Compiled projects pack scripts/scenes/resources into a `.pck` file (or
  embed it in the executable).
- **GDRE Tools (Godot RE Tools)** is the standard: extracts `.pck`
  contents and decompiles GDScript bytecode back to readable `.gd` source,
  recovers scenes/resources in editable form.
- For C#-scripted Godot projects, it's a normal .NET assembly — same
  dnSpy/ILSpy workflow as Unity Mono.

**Cocos2d-x / Cocos Creator**

- Game logic is commonly JavaScript or Lua, bundled and often minified
  or byte-compiled.
- JS: if it's source (even minified/obfuscated via a JS obfuscator), a JS
  beautifier plus manual deobfuscation (resolving a string-array
  indirection layer is the most common obfuscation pattern) gets you
  readable logic.
- Lua: if compiled to Lua bytecode, use a matching **luadec**/**unluac**
  build for the project's exact Lua version (5.1 vs 5.3 bytecode formats
  differ) to decompile back to Lua source.
- Textures/audio are typically standard formats or simple custom archives
  (`.plist`-described texture atlases) — straightforward to unpack with
  general-purpose or Cocos-specific extraction scripts.

---

## Output standard

When reporting findings:

1. Lead with a one-paragraph summary of what the binary/target does.
2. Then the evidence: specific functions/addresses, decompiled snippets
   (your own re-derived pseudocode, not a raw dump with no analysis),
   debugger traces that confirmed behavior.
3. Flag anything unresolved — "this routine's purpose is unclear, hits an
   unresolved indirect call at 0x1402A30, needs dynamic trace" is a valid
   and honest stopping point, better than a confident guess.
4. When producing scripts/tools to automate part of the analysis (IDAPython,
   Ghidra scripts, Frida hooks, parsers for a recovered file format), ship
   them complete and runnable, with a one-line header noting language,
   target tool/version, and what input they expect.

Never fabricate a decompilation you haven't actually derived from the
binary, and never present a hypothesis as confirmed behavior without
having traced or tested it.
