import type { GoBinary } from "./go/goBinary.js";
import type { ReleaseExposureNativeImage } from "./releaseExposure.js";

const filesystemPath = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value.length === 0) return null;
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    return value;
  return null;
};

/** Go build settings whose values are flags. */
const GO_FLAG_SETTING =
  /^(?:CGO_[A-Z]+FLAGS|-asmflags|-gccgoflags|-gcflags|-ldflags)$/u;
/**
 * `-pgo file` names one profile, so its value is a whole path, or under
 * `-trimpath` the bare file name; `auto` and `off` name no file.
 */
const goProfilePath = (value: string): string | null =>
  value.length === 0 || value === "auto" || value === "off" ? null : value;
/**
 * One field as Go's `quoted.Split` reads a flag value: a field that begins with
 * `"` or `'` runs to the matching quote, which it drops; any other field runs to
 * whitespace and keeps every quote in it as a literal character.
 */
const GO_FLAG_FIELD = /"([^"]*)"|'([^']*)'|[^\s"'][^\s]*/gu;
/** A path after a flag prefix, whitespace, `=`, or `,`, as in `-isystem/opt/x`. */
const GO_FLAG_PATH =
  /(?:^|[\s=,])(?:-(?:idirafter|imacros|include|iprefix|iquote|isysroot|isystem|[BFILT]))?((?:\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\{2}[^\\\s=,]+\\)[^=,]+)/gu;

/**
 * Settings read by a C compiler, where the flags below take a directory or file.
 * Go's own tools reuse those letters: `-ldflags` takes `-B gobuildid` and
 * `-T 0x1000`, so their relative arguments are not paths. The exact field
 * `-I-` is GCC's include barrier, the same as `--include-barrier`, and names
 * no directory.
 */
const GO_COMPILER_SETTING = /^(?:CGO_[A-Z]+FLAGS|-gccgoflags)$/u;
const GO_COMPILER_PATH_FLAG =
  /^(?:-(?:idirafter|imacros|include|iprefix|iquote|isysroot|isystem|[BFLT]|I(?!-$))=?\s*|--sysroot(?:=|\s+|$))(.*)$/su;
/**
 * Linker options a C compiler forwards through `-Wl,a,b` or `-Xlinker a`. The
 * linker reads its own letters: `-L`, `-T` and `-I` (the ELF interpreter) take
 * a path, `-Bstatic` does not, and `-Ttext=0x400000` and its siblings set a
 * section or segment address. `-rpath` and `-rpath-link` take a runtime or
 * link-time library search directory. `--version-script`, `--dynamic-list` and
 * `--retain-symbols-file` read a file, as `--script` does, and `-Map` writes
 * the linker map to one. `--just-symbols` reads a symbol file; it is the long
 * spelling of `-R`, but only `-R` turns into `-rpath` for a directory.
 * `--sysroot` sets the linker's own sysroot directory, apart from the one the
 * compiler driver reads.
 */
const LINKER_PATH_FLAG =
  /^(?:-(?!T(?:bss|data|text|(?:ldata|rodata|text)-segment)(?:=|$))[ILRT]|-{1,2}(?:dynamic-linker|dynamic-list|just-symbols|library-path|Map|retain-symbols-file|rpath|rpath-link|script|sysroot|version-script)(?==|$))=?(.*)$/su;
type NativeImageFormat = ReleaseExposureNativeImage["format"];
/**
 * A runtime search path the image's loader expands, which names no directory
 * on the build host. The ELF loader expands `$ORIGIN/../lib`; dyld expands
 * `@loader_path/Frameworks`. Each token is literal text to the other loader,
 * and the PE loader reads no search list, so it expands neither.
 */
const DYLD_RUNTIME_TOKEN = /^@(?:executable_path|loader_path|rpath)(?:\/|$)/u;
const LINKER_RUNTIME_TOKENS: Record<NativeImageFormat, RegExp | null> = {
  elf: /^(?:\$(?:ORIGIN|LIB|PLATFORM)\b|\$\{(?:ORIGIN|LIB|PLATFORM)\})/u,
  "mach-o": DYLD_RUNTIME_TOKEN,
  "mach-o-universal": DYLD_RUNTIME_TOKEN,
  pe: null,
};
/** `-rpath` and `-rpath-link` take a search list, not one directory. */
const LINKER_SEARCH_LIST_FLAG = /^-{1,2}(?:rpath|rpath-link)(?==|$)/u;
/**
 * The `:` between search list entries. A `:` after a lone drive letter, as in
 * `C:\lib`, is part of the entry.
 */
const LINKER_SEARCH_LIST_SEPARATOR = /(?<!(?:^|:)[A-Za-z]):/u;
/**
 * The options `go tool link -h` documents as taking a directory, path or file,
 * as `-L dir` or `-L=dir`, never attached. `-extld` and `-extar` name
 * programs, so only their rooted values read as paths. `-libgcc` takes a file
 * or the disabling sentinel `none`.
 */
const GO_LINKER_PATH_FLAG =
  /^-{1,2}(?:I|L|benchmarkprofile|capturehostobjs|cpuprofile|fipso|importcfg|libgcc|memprofile|o|r|tmpdir)(?:=|$)(.*)$/su;
/** The options `go tool compile -h` documents as taking a directory, path or file. */
const GO_COMPILE_PATH_FLAG =
  /^-{1,2}(?:D|I|asmhdr|bench|blockprofile|coveragecfg|cpuprofile|embedcfg|importcfg|linkobj|memprofile|mutexprofile|o|pgoprofile|symabis|traceprofile|trimpath)(?:=|\s+|$)(.*)$/su;
/** `go tool asm` shares `-I`, `-o` and `-trimpath`, but its `-D` defines a symbol. */
const GO_ASSEMBLE_PATH_FLAG = /^-{1,2}(?:I|o|trimpath)(?:=|\s+|$)(.*)$/su;
const GO_TOOL_PATH_FLAGS = new Map([
  ["-asmflags", GO_ASSEMBLE_PATH_FLAG],
  ["-gcflags", GO_COMPILE_PATH_FLAG],
  ["-ldflags", GO_LINKER_PATH_FLAG],
]);
/** The one `pattern=` that `go build` allows before a setting's first flag. */
const GO_PACKAGE_SELECTOR = /^[^\s=-][^\s=]*=(?=-)/u;
/**
 * `go tool link -extldflags` passes its value, split like any Go flag value, to
 * the external linker, which Go runs through the C compiler driver.
 */
const GO_EXTERNAL_LINKER_FLAGS = /^-{1,2}extldflags(?:=(.*))?$/su;

/** Fields in one value, without their delimiting quotes. */
const goFields = (value: string): string[] =>
  [...value.matchAll(GO_FLAG_FIELD)].map(
    ([field, double, single]) => double ?? single ?? field,
  );

/** Rooted paths in flags, with their `=` and `,` structure kept. */
const flagPaths = (flags: string[]): string[] =>
  flags.flatMap((flag) =>
    [...flag.matchAll(GO_FLAG_PATH)].flatMap(([, path]) =>
      path === undefined ? [] : [path],
    ),
  );

/** Consume each normalized linker option and its operand exactly once. */
const linkerPaths = (
  flags: string[],
  format: NativeImageFormat,
  onAmbiguousLinkerR: () => void,
): { paths: string[]; searchPaths: string[]; remaining: string[] } => {
  const paths: string[] = [];
  const searchPaths: string[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === undefined) continue;
    const attached = LINKER_PATH_FLAG.exec(flag)?.[1];
    if (attached === undefined) {
      remaining.push(flag);
      continue;
    }
    const next = flags[index + 1];
    const fromNext =
      attached.length === 0 && !flag.endsWith("=") && next !== undefined;
    const argument = fromNext ? next : attached;
    if (fromNext) index += 1;
    if (argument.length === 0) continue;
    if (LINKER_SEARCH_LIST_FLAG.test(flag)) {
      searchPaths.push(...searchListEntries(argument, format));
      continue;
    }
    if (
      flag.startsWith("-R") &&
      format === "elf" &&
      LINKER_RUNTIME_TOKENS.elf?.test(argument) === true
    ) {
      onAmbiguousLinkerR();
      continue;
    }
    if (/^-{1,2}Map(?:=|$)/u.test(flag) && argument === "-") continue;
    paths.push(argument);
  }
  return { paths, searchPaths, remaining };
};

/**
 * `-trimpath` takes `prefix=replacement` rewrites separated by `;`, so its
 * rooted value is read by `flagPaths` with that structure kept.
 */
const GO_PATH_LIST_FLAG = /^-{1,2}trimpath(?:=|\s+|$)/u;
/**
 * `go tool link -r` sets the dynamic linker search path, `dir1:dir2:...`, so
 * it is read entry by entry like a forwarded `-rpath`.
 */
const GO_LINKER_SEARCH_LIST_FLAG = /^-{1,2}r(?:=|\s+|$)/u;

/**
 * A runtime search list's build-host entries. Only the ELF loader splits a
 * list at `:`; dyld reads each argument as one directory. An entry the image's
 * loader expands, such as `$ORIGIN` on ELF, drops only itself.
 */
const searchListEntries = (
  list: string,
  format: NativeImageFormat,
): string[] => {
  const token = LINKER_RUNTIME_TOKENS[format];
  return (
    format === "elf" ? list.split(LINKER_SEARCH_LIST_SEPARATOR) : [list]
  ).filter((entry) => entry.length > 0 && token?.test(entry) !== true);
};

/** Consume compiler operands before interpreting any remaining forwarding syntax. */
const splitForwardedLinkerFlags = (
  flags: string[],
): { compiler: string[]; linker: string[]; paths: string[] } => {
  const compiler: string[] = [];
  const linker: string[] = [];
  const paths: string[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === undefined) continue;
    const attached = GO_COMPILER_PATH_FLAG.exec(flag)?.[1];
    if (attached !== undefined) {
      const next = flags[index + 1];
      const fromNext =
        attached.length === 0 && !flag.endsWith("=") && next !== undefined;
      const argument = fromNext ? next : attached;
      if (argument.length > 0) paths.push(argument);
      if (fromNext) index += 1;
    } else if (flag === "-Xlinker" && flags[index + 1] !== undefined) {
      const forwarded = flags[index + 1];
      if (forwarded !== undefined) linker.push(forwarded);
      index += 1;
    } else if (flag.startsWith("-Wl,"))
      linker.push(...flag.slice(4).split(","));
    else compiler.push(flag);
  }
  return { compiler, linker, paths };
};

/**
 * Options whose separate argument is a dyld install name or path, which may
 * start with a runtime token such as `@rpath`: `-install_name @rpath/libx.dylib`.
 */
const LINKER_DYLD_VALUE_FLAG =
  /^-{1,2}(?:dylib_file|dylib_install_name|install_name|rpath)$/u;

/**
 * Each `@FILE` response file the compiler driver or linker reads options from,
 * named in its own argument and never opened here. An argument after an option
 * that takes one is that option's value, as is a dyld runtime token after
 * `-install_name`; a standalone `@rpath/x.rsp` is still a response file.
 */
const responseFilePaths = (args: string[], pathFlag: RegExp): string[] =>
  args.flatMap((arg, index) => {
    if (!arg.startsWith("@")) return [];
    const path = arg.slice(1);
    const previous = args[index - 1];
    return path.length === 0 ||
      (previous !== undefined &&
        (pathFlag.exec(previous)?.[1] === "" ||
          LINKER_DYLD_VALUE_FLAG.test(previous)))
      ? []
      : [path];
  });

/**
 * Rooted and relative paths in flags a C compiler driver reads. A forwarded
 * search list is read entry by entry, so an entry the image's loader expands,
 * such as `$ORIGIN` on ELF, drops only itself. Only a search list is loader-expanded: the
 * argument of `-T`, `-L` or `-I` is a literal path even when it reads `$ORIGIN`.
 * Only the ELF linker splits a search list at `:`. The Mach-O linker stores
 * each `-rpath` argument as one directory, so `@loader_path/lib:extra` is one
 * loader-relative entry.
 */
const compilerPaths = (
  value: string,
  format: NativeImageFormat,
  onAmbiguousLinkerR: () => void,
): string[] => {
  const { compiler, linker, paths } = splitForwardedLinkerFlags(
    goFields(value),
  );
  const extracted = linkerPaths(linker, format, onAmbiguousLinkerR);
  return [
    ...flagPaths([...compiler, ...extracted.remaining]),
    ...paths,
    ...extracted.paths,
    ...responseFilePaths(compiler, GO_COMPILER_PATH_FLAG),
    ...responseFilePaths(extracted.remaining, LINKER_PATH_FLAG),
    ...extracted.searchPaths,
  ];
};

/** Interpret a consumed Go path operand without treating its bytes as more flags. */
const goToolOperandPaths = (
  flag: string,
  argument: string,
  pathFlag: RegExp | undefined,
  format: NativeImageFormat,
): { paths: string[]; remaining: string[] } => {
  if (
    argument.length === 0 ||
    (pathFlag === GO_LINKER_PATH_FLAG &&
      /^-{1,2}libgcc(?:=|$)/u.test(flag) &&
      argument === "none")
  )
    return { paths: [], remaining: [] };
  if (GO_PATH_LIST_FLAG.test(flag))
    return {
      paths: filesystemPath(argument) === null ? [argument] : [],
      remaining: [argument],
    };
  return {
    paths: GO_LINKER_SEARCH_LIST_FLAG.test(flag)
      ? searchListEntries(argument, format)
      : [argument],
    remaining: [],
  };
};

/**
 * Paths in a flag setting. Each `-extldflags` value is read only as the
 * external linker splits it, so a path quoted inside it is read whole.
 */
const goSettingPaths = (
  key: string,
  value: string,
  format: NativeImageFormat,
  onAmbiguousLinkerR: () => void,
): string[] => {
  if (GO_COMPILER_SETTING.test(key))
    return compilerPaths(value, format, onAmbiguousLinkerR);
  const pathFlag = GO_TOOL_PATH_FLAGS.get(key);
  const fields = goFields(value);
  const paths: string[] = [];
  const external: string[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined) continue;
    const flag = index === 0 ? field.replace(GO_PACKAGE_SELECTOR, "") : field;
    const attached = pathFlag?.exec(flag)?.[1];
    if (attached !== undefined) {
      const next = fields[index + 1];
      const fromNext =
        attached.length === 0 && !flag.endsWith("=") && next !== undefined;
      const argument = fromNext ? next : attached;
      if (fromNext) index += 1;
      const operand = goToolOperandPaths(flag, argument, pathFlag, format);
      paths.push(...operand.paths);
      remaining.push(...operand.remaining);
      continue;
    }
    const externalFlags = GO_EXTERNAL_LINKER_FLAGS.exec(flag);
    if (externalFlags !== null) {
      const argument = externalFlags[1] ?? fields[++index];
      if (argument !== undefined) external.push(argument);
      continue;
    }
    remaining.push(field);
    if (/^-{1,2}X$/u.test(flag)) {
      const argument = fields[++index];
      if (argument !== undefined) remaining.push(argument);
    }
  }
  return [
    ...flagPaths(remaining),
    ...paths,
    ...external.flatMap((flags) =>
      compilerPaths(flags, format, onAmbiguousLinkerR),
    ),
  ];
};

export const goBuildPaths = (
  module: NonNullable<GoBinary["build_info"]>["module"],
  format: NativeImageFormat,
): { readonly paths: string[]; readonly ambiguousLinkerR: boolean } => {
  const paths = new Set<string>();
  let ambiguousLinkerR = false;
  const add = (value: string | null | undefined) => {
    const path = filesystemPath(value);
    if (path !== null) paths.add(path);
  };
  add(module.path);
  add(module.main?.path);
  add(module.main?.replacement?.path);
  for (const dependency of module.dependencies) {
    add(dependency.path);
    add(dependency.replacement?.path);
  }
  for (const setting of module.settings) {
    if (setting.key === "-pgo") {
      const path = goProfilePath(setting.value);
      if (path !== null) paths.add(path);
      continue;
    }
    if (!GO_FLAG_SETTING.test(setting.key)) continue;
    for (const path of goSettingPaths(
      setting.key,
      setting.value,
      format,
      () => {
        ambiguousLinkerR = true;
      },
    ))
      paths.add(path);
  }
  return { paths: [...paths], ambiguousLinkerR };
};
