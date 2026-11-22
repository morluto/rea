import { describe, expect, it } from "vitest";

import { goBuildPaths } from "./releaseExposureGoPaths.js";

const extract = (key: string, value: string) =>
  goBuildPaths(
    {
      path: "example.test/app",
      main: null,
      dependencies: [],
      settings: [{ key, value }],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    },
    "elf",
  );

describe("Go tool path flags", () => {
  it.each([
    ["-ldflags", "-tmpdir=private-obj -s -w", "private-obj"],
    ["-ldflags", "-tmpdir private-obj", "private-obj"],
    ["-ldflags", "-capturehostobjs private-objs", "private-objs"],
    ["-ldflags", "-cpuprofile=link.prof", "link.prof"],
    ["-ldflags", "-importcfg private.cfg", "private.cfg"],
    ["-ldflags", "-o out/app", "out/app"],
    ["-ldflags", "-r private-lib", "private-lib"],
    ["-ldflags", "-r -private", "-private"],
    ["-ldflags", "-L -private", "-private"],
    ["-ldflags", "-r -L", "-L"],
    ["-ldflags", "-r= -L private-sdk", "private-sdk"],
    ["-ldflags", "'-L=/tmp/private '", "/tmp/private "],
    ["-ldflags", "-L build\u00a0objects", "build\u00a0objects"],
    ["-ldflags", "-libgcc -private.a", "-private.a"],
    [
      "-ldflags",
      "-s -w -libgcc=private-toolchain/libgcc.a",
      "private-toolchain/libgcc.a",
    ],
    [
      "-ldflags",
      "-libgcc private-toolchain/libgcc.a",
      "private-toolchain/libgcc.a",
    ],
    ["-ldflags", "-L -X main.name=private", "-X"],
    ["-ldflags", "-L -extldflags=-Lprivate", "-extldflags=-Lprivate"],
    ["-ldflags", "all=-L -X main.name=private", "-X"],
    ["-gcflags", "-I private-sdk", "private-sdk"],
    ["-gcflags", "-I=private-sdk", "private-sdk"],
    ["-gcflags", "--I private-sdk", "private-sdk"],
    ["-gcflags", "all=-N -l -I private-sdk", "private-sdk"],
    ["-gcflags", "-importcfg private-sdk", "private-sdk"],
    ["-gcflags", "-trimpath private-sdk", "private-sdk"],
    ["-asmflags", "-I private-sdk", "private-sdk"],
    ["-asmflags", "all=-trimpath=private-sdk", "private-sdk"],
  ])("keeps the complete operand in %s=%s", (key, value, path) => {
    expect(extract(key, value)).toEqual({
      paths: [path],
      ambiguousLinkerR: false,
    });
  });

  it.each([
    ["-ldflags", "-extld clang -extar ar -libgcc none"],
    ["-ldflags", "-libgcc=none"],
    ["-ldflags", "-buildmode pie -linkmode external -installsuffix race"],
    ["-ldflags", "-X main.value=prefix\u00a0/suffix"],
    ["-gcflags", "all=-N -l"],
    ["-gcflags", "-p main -lang go1.26 -m"],
    ["-gcflags", "-X main.path=private-sdk"],
    ["-asmflags", "-D GOAMD64_v1 -p main"],
  ])("skips non-path operands in %s=%s", (key, value) => {
    expect(extract(key, value)).toEqual({ paths: [], ambiguousLinkerR: false });
  });
});

describe("C compiler and forwarded linker paths in Go metadata", () => {
  it.each([
    ["CGO_CFLAGS", "'-I/tmp/private,sdk'", ["/tmp/private,sdk"]],
    ["CGO_CFLAGS", "'-I/tmp/private=sdk'", ["/tmp/private=sdk"]],
    ["CGO_CFLAGS", "'-I/tmp/private '", ["/tmp/private "]],
    ["CGO_CFLAGS", "-O2 -I\u00a0headers", ["\u00a0headers"]],
    [
      "CGO_CFLAGS",
      "-O2 -fprofile-use=internal/profiles",
      ["internal/profiles"],
    ],
    ["CGO_CFLAGS", "'-fprofile-dir=private profiles'", ["private profiles"]],
    [
      "-ldflags",
      "-extldflags=-fprofile-generate=private/gcov",
      ["private/gcov"],
    ],
    ["CGO_CFLAGS", "-fprofile-use -fprofile-generate -O2", []],
    [
      "CGO_CFLAGS",
      '-O2 -I\\\\buildhost\\sdk\\include "-isystem \\\\buildhost\\my sdk\\include"',
      ["\\\\buildhost\\sdk\\include", "\\\\buildhost\\my sdk\\include"],
    ],
    ["CGO_CFLAGS", "-DNAME=\\\\ -DHOST=\\\\buildhost", []],
    ["CGO_CFLAGS", "-I..\\sdk\\include", ["..\\sdk\\include"]],
    ["CGO_CFLAGS", "-O2 -I.\\sdk", [".\\sdk"]],
    ["CGO_CFLAGS", '"-isystem ..\\my sdk\\include"', ["..\\my sdk\\include"]],
    [
      "CGO_LDFLAGS",
      "-Wl,-T,/tmp/private=sdk/link.ld",
      ["/tmp/private=sdk/link.ld"],
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,--version-script=/tmp/private=sdk/exports",
      ["/tmp/private=sdk/exports"],
    ],
    [
      "CGO_LDFLAGS",
      "-Xlinker -T -Xlinker /tmp/private,sdk/link.ld",
      ["/tmp/private,sdk/link.ld"],
    ],
    [
      "CGO_LDFLAGS",
      "-Xlinker -L -Xlinker /tmp/private=sdk",
      ["/tmp/private=sdk"],
    ],
    ["CGO_LDFLAGS", "'-Wl,-L/tmp/private '", ["/tmp/private "]],
    ["CGO_LDFLAGS", "-Xlinker -L -Xlinker '/tmp/private '", ["/tmp/private "]],
    ["CGO_CFLAGS", "-I -Wl,-rpath,$ORIGIN", ["-Wl,-rpath,$ORIGIN"]],
    ["CGO_CFLAGS", "-I -Wl,-L,/tmp/private", ["-Wl,-L,/tmp/private"]],
    ["CGO_CFLAGS", "-I -Xlinker", ["-Xlinker"]],
    [
      "CGO_CFLAGS",
      "-I -Wl,-rpath,$ORIGIN -Wl,-L,other-sdk",
      ["-Wl,-rpath,$ORIGIN", "other-sdk"],
    ],
    ["CGO_LDFLAGS", "-Wl,-T,-rpath,private-sdk", ["-rpath"]],
    ["CGO_LDFLAGS", "-Wl,-L,-private-sdk", ["-private-sdk"]],
    ["CGO_LDFLAGS", "-Wl,-rpath=-private-sdk", ["-private-sdk"]],
    [
      "CGO_LDFLAGS",
      "-Xlinker -rpath -Xlinker '/tmp/private '",
      ["/tmp/private "],
    ],
    ["CGO_LDFLAGS", "'-Wl,@private '", ["private "]],
    ["CGO_CFLAGS", "'-DROOT=/tmp/private '", ["/tmp/private "]],
  ] as const)(
    "interprets the operating tool's path in %s=%s",
    (key, value, paths) => {
      expect(extract(key, value)).toEqual({ paths, ambiguousLinkerR: false });
    },
  );
});
