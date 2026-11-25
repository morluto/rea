import { describe, expect, it } from "vitest";

import type { ReleaseExposureNativeImage } from "./releaseExposure.js";
import { goBuildPaths } from "./releaseExposureGoPaths.js";

const extract = (
  key: string,
  value: string,
  format: ReleaseExposureNativeImage["format"] = "elf",
) =>
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
    format,
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

describe("Go trimpath rewrites", () => {
  it.each([
    [
      "-gcflags",
      "all=-trimpath=/src=a=>/mapped/build;/private/sdk=>example.test/app",
      ["/src=a", "/mapped/build", "/private/sdk"],
    ],
    [
      "-asmflags",
      "all=-trimpath=/old=>prefix=>/mapped/path",
      ["/old=>prefix", "/mapped/path"],
    ],
    ["-gcflags", "-trimpath src=/srv/build", ["src=/srv/build"]],
    [
      "-gcflags",
      "-trimpath=src=>/srv/build;;=>/not-applied",
      ["src", "/srv/build"],
    ],
  ])("interprets %s=%s with Go's rewrite boundaries", (key, value, paths) => {
    expect(extract(key, value)).toEqual({ paths, ambiguousLinkerR: false });
  });
});

type GoPathCase = readonly [
  key: string,
  value: string,
  paths: readonly string[],
  format?: ReleaseExposureNativeImage["format"],
  ambiguousLinkerR?: boolean,
];

const checkPathCase = ([
  key,
  value,
  paths,
  format,
  ambiguousLinkerR = false,
]: GoPathCase) => {
  expect(extract(key, value, format)).toEqual({ paths, ambiguousLinkerR });
};

describe("Go and platform linker search lists", () => {
  const cases: readonly GoPathCase[] = [
    ["-ldflags", "-r=$ORIGIN/../lib -s -w", []],
    ["-ldflags", "-r ${ORIGIN}/lib:$ORIGIN", []],
    [
      "-ldflags",
      "-r=$ORIGIN/../lib:/opt/private-runtime",
      ["/opt/private-runtime"],
    ],
    ["-ldflags", "-r /opt/a:$ORIGIN/lib:vendor/lib", ["/opt/a", "vendor/lib"]],
    [
      "-ldflags",
      "-r a:$ORIGIN:/opt/private-runtime",
      ["a", "/opt/private-runtime"],
    ],
    ["-ldflags", "-r=@loader_path/lib:extra", [], "mach-o"],
    ["-ldflags", "-r=$ORIGIN/../lib", ["$ORIGIN/../lib"], "mach-o"],
    ["CGO_LDFLAGS", "-Wl,-rpath,private-runtime", ["private-runtime"]],
    ["CGO_LDFLAGS", "-Wl,-rpath=private-runtime", ["private-runtime"]],
    ["CGO_LDFLAGS", "-Wl,--rpath=private-runtime", ["private-runtime"]],
    [
      "CGO_LDFLAGS",
      "-Xlinker -rpath -Xlinker private-runtime",
      ["private-runtime"],
    ],
    ["CGO_LDFLAGS", "-Wl,-rpath-link,private-runtime", ["private-runtime"]],
    ["CGO_LDFLAGS", "-Wl,-rpath-link=private-runtime", ["private-runtime"]],
    ["CGO_LDFLAGS", "-Wl,--rpath-link,private-runtime", ["private-runtime"]],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath,$ORIGIN:/opt/private-runtime",
      ["/opt/private-runtime"],
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath=${ORIGIN}/lib:private-runtime",
      ["private-runtime"],
    ],
    [
      "CGO_LDFLAGS",
      "-Xlinker -rpath -Xlinker /opt/a:$ORIGIN/lib:/opt/b",
      ["/opt/a", "/opt/b"],
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath-link,/opt/a:vendor/lib",
      ["/opt/a", "vendor/lib"],
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath,a:/opt/private-runtime",
      ["a", "/opt/private-runtime"],
    ],
    ["CGO_LDFLAGS", "-Wl,-rpath-link,a:vendor/lib", ["a", "vendor/lib"]],
    ["CGO_LDFLAGS", "-Wl,-T,$ORIGIN.ld", ["$ORIGIN.ld"]],
    [
      "CGO_LDFLAGS",
      "-Xlinker -T -Xlinker ${ORIGIN}/link.ld",
      ["${ORIGIN}/link.ld"],
    ],
    ["CGO_LDFLAGS", "-Wl,-L,$ORIGIN/lib", ["$ORIGIN/lib"]],
    ["CGO_LDFLAGS", "-Wl,-L,$ORIGIN -Wl,-rpath,$ORIGIN", ["$ORIGIN"]],
    ["CGO_LDFLAGS", "-Wl,-L,$ORIGIN,-rpath,$ORIGIN", ["$ORIGIN"]],
    [
      "CGO_LDFLAGS",
      "-Xlinker -L -Xlinker $ORIGIN -Xlinker -rpath -Xlinker $ORIGIN",
      ["$ORIGIN"],
    ],
    ["CGO_LDFLAGS", "-Wl,-rpath=$ORIGIN -Wl,-T,$ORIGIN", ["$ORIGIN"]],
    ["CGO_LDFLAGS", "-Wl,-rpath,@loader_path/lib:extra", [], "mach-o"],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath,$ORIGIN:/opt/private-runtime",
      ["$ORIGIN:/opt/private-runtime"],
      "mach-o",
    ],
    ["CGO_LDFLAGS", "-Wl,-rpath,/opt/a:b", ["/opt/a:b"], "mach-o"],
    ["CGO_LDFLAGS", "-Wl,-rpath,$ORIGIN/../lib -Wl,-rpath=${ORIGIN}/lib", []],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath,@loader_path/Frameworks -Xlinker -rpath -Xlinker @executable_path",
      [],
      "mach-o",
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,-rpath,@loader_path/Frameworks",
      ["@loader_path/Frameworks"],
    ],
    ["CGO_LDFLAGS", "-Wl,-rpath,$ORIGIN/../lib", ["$ORIGIN/../lib"], "mach-o"],
    ["CGO_LDFLAGS", "-Wl,-R,$ORIGIN/../lib", [], "elf", true],
    ["-ldflags", "-extldflags=-Wl,-R,$ORIGIN/../lib", [], "elf", true],
    ["CGO_LDFLAGS", "-Wl,-R,private-runtime", ["private-runtime"]],
  ];
  it.for(cases)("interprets %s=%s", checkPathCase);
});

describe("Go tool operand spelling", () => {
  const cases: readonly GoPathCase[] = [
    ["-ldflags", `-L "/tmp/private,sdk" -s -w`, ["/tmp/private,sdk"]],
    ["-ldflags", `-L "/tmp/private=sdk" -s -w`, ["/tmp/private=sdk"]],
    ["-ldflags", `-L=/tmp/private,sdk -s -w`, ["/tmp/private,sdk"]],
    ["-ldflags", `all=-L=/tmp/private,sdk`, ["/tmp/private,sdk"]],
    ["-ldflags", `-tmpdir /srv/obj,1`, ["/srv/obj,1"]],
    ["-ldflags", `-L "/tmp/private=-sdk"`, ["/tmp/private=-sdk"]],
    ["-ldflags", "-B gobuildid -L private-sdk -s -w", ["private-sdk"]],
    ["-ldflags", "-B gobuildid -L=private-sdk -s -w", ["private-sdk"]],
    [
      "-ldflags",
      `-B gobuildid ${`-L "private - sdk" -s -w`}`,
      ["private - sdk"],
    ],
    [
      "-ldflags",
      `-B gobuildid ${`-L "/tmp/private - sdk" -s -w`}`,
      ["/tmp/private - sdk"],
    ],
    [
      "-ldflags",
      `-B gobuildid ${`-s "-L=/tmp/private - sdk" -w`}`,
      ["/tmp/private - sdk"],
    ],
    [
      "-ldflags",
      `-B gobuildid ${`"-L=private - sdk -s -w"`}`,
      ["private - sdk -s -w"],
    ],
    [
      "-ldflags",
      "-B gobuildid -X main.version=1 -L private-sdk",
      ["private-sdk"],
    ],
    ["-ldflags", "all=-L private-sdk -s -w", ["private-sdk"]],
    ["-ldflags", "all=-s -L private-sdk", ["private-sdk"]],
    [
      "-ldflags",
      "github.com/acme/...=-B gobuildid -L private-sdk",
      ["private-sdk"],
    ],
    ["-ldflags", `-X 'main.usage=-L level'`, []],
    ["-ldflags", `-X 'main.usage=see -L level'`, []],
    ["-ldflags", `-X '-L level'`, []],
    ["-ldflags", `-X main.usage=-L level`, []],
    ["-ldflags", `--X 'main.usage=-L level'`, []],
    ["-ldflags", `all=-X 'main.usage=-L level'`, []],
    ["-ldflags", `"-X main.usage=-L level"`, []],
    ["CGO_CFLAGS", `-I"/home/O'Neil/include"`, [`"/home/O'Neil/include"`]],
    ["CGO_CFLAGS", `"-I/home/O'Neil/include"`, ["/home/O'Neil/include"]],
    ["CGO_CFLAGS", `'-I/home/O"Neil/include'`, [`/home/O"Neil/include`]],
    ["-ldflags", `-X='main.usage=see -L level'`, ["level'"]],
    ["CGO_CFLAGS", `"-isystem /opt/my sdk/include"`, ["/opt/my sdk/include"]],
    ["CGO_CFLAGS", `"-I private sdk/include"`, ["private sdk/include"]],
    ["CGO_CFLAGS", `-I "/opt/private - sdk"`, ["/opt/private - sdk"]],
    ["-pgo", "private-training.pgo", ["private-training.pgo"]],
    ["-pgo", "/srv/my profiles/a,b.pgo", ["/srv/my profiles/a,b.pgo"]],
    ["-pgo", "auto", []],
    ["-pgo", "off", []],
    ["-ldflags", "-B gobuildid -T 0x1000 -s -w", []],
    ["CGO_CFLAGS", '"-I/opt/my sdk/include" -O2', ["/opt/my sdk/include"]],
    [
      "CGO_CXXFLAGS",
      "-isystem/opt/isystem -iquote /opt/quote",
      ["/opt/isystem", "/opt/quote"],
    ],
    [
      "CGO_LDFLAGS",
      '"-L/opt/my libs" -T/opt/link.ld',
      ["/opt/my libs", "/opt/link.ld"],
    ],
    ["-ldflags", '-extldflags "-L/srv/ext lib -static"', ["/srv/ext"]],
    ["-pgo", "/srv/default.pgo", ["/srv/default.pgo"]],
  ];
  it.for(cases)("interprets %s=%s", checkPathCase);
});

describe("Forwarded linker response files", () => {
  const cases: readonly GoPathCase[] = [
    ["CGO_LDFLAGS", "-Wl,@/tmp/private-link.rsp", ["/tmp/private-link.rsp"]],
    [
      "CGO_LDFLAGS",
      "-Xlinker @/tmp/private-link.rsp",
      ["/tmp/private-link.rsp"],
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,--as-needed,@/tmp/private-link.rsp",
      ["/tmp/private-link.rsp"],
    ],
    ["CGO_LDFLAGS", "-Wl,@private-link.rsp", ["private-link.rsp"]],
    ["CGO_LDFLAGS", "@/tmp/private-cc.rsp", ["/tmp/private-cc.rsp"]],
    ["CGO_LDFLAGS", "-Wl,@rpath/private-link.rsp", ["rpath/private-link.rsp"]],
    [
      "CGO_LDFLAGS",
      "-Xlinker @loader_path/private-link.rsp",
      ["loader_path/private-link.rsp"],
    ],
    ["CGO_LDFLAGS", "-Wl,-install_name,@rpath/libprivate.dylib", []],
    [
      "CGO_LDFLAGS",
      "-Xlinker -install_name -Xlinker @rpath/libprivate.dylib",
      [],
    ],
    ["CGO_LDFLAGS", "-Wl,-rpath,@loader_path/lib", ["@loader_path/lib"]],
    [
      "CGO_LDFLAGS",
      "-Wl,-dylib_file,@rpath/libprivate.dylib:/opt/lib/libprivate.dylib",
      [],
    ],
    ["CGO_LDFLAGS", "-Wl,@", []],
  ];
  it.for(cases)("interprets %s=%s", checkPathCase);
});

describe("Compiler and linker file operands", () => {
  const cases: readonly GoPathCase[] = [
    ["CGO_LDFLAGS", "--sysroot=private-sdk", ["private-sdk"]],
    ["CGO_LDFLAGS", "--sysroot private-sdk", ["private-sdk"]],
    ["CGO_LDFLAGS", "-Wl,-L,private-sdk -lssl", ["private-sdk"]],
    ["CGO_LDFLAGS", "-Wl,-Lprivate-sdk", ["private-sdk"]],
    ["CGO_LDFLAGS", "-Wl,--library-path=private-sdk", ["private-sdk"]],
    ["CGO_LDFLAGS", "-Wl,-T,link.ld", ["link.ld"]],
    ["CGO_LDFLAGS", "-Xlinker -L -Xlinker private-sdk", ["private-sdk"]],
    ["CGO_LDFLAGS", "-Xlinker -Ilib/ld-custom.so", ["lib/ld-custom.so"]],
    [
      "CGO_LDFLAGS",
      "-Wl,--dynamic-linker=lib/ld-custom.so",
      ["lib/ld-custom.so"],
    ],
    [
      "CGO_LDFLAGS",
      "-Wl,-dynamic-linker,lib/ld-custom.so",
      ["lib/ld-custom.so"],
    ],
    ["CGO_LDFLAGS", "-Wl,-Tlink.ld,-Ttext=0x400000", ["link.ld"]],
    ["-ldflags", "-extldflags=-Lprivate-sdk -s -w", ["private-sdk"]],
    ["-ldflags", "-extldflags -Lprivate-sdk -s -w", ["private-sdk"]],
    ["-ldflags", `-extldflags "-L private-sdk -static"`, ["private-sdk"]],
    ["-ldflags", `all=-extldflags '-Wl,-L,private-sdk'`, ["private-sdk"]],
    [
      "-ldflags",
      `-extldflags "-Xlinker -L -Xlinker private-sdk"`,
      ["private-sdk"],
    ],
    ["-ldflags", `-extldflags '-L "/srv/private sdk"'`, ["/srv/private sdk"]],
    [
      "-ldflags",
      `-extldflags '-L "/tmp/private - sdk"'`,
      ["/tmp/private - sdk"],
    ],
    ["-ldflags", "-extldflags=-Wl,--sysroot=private-sdk", ["private-sdk"]],
    ["-ldflags", "-extldflags '-Wl,--sysroot,private-sdk'", ["private-sdk"]],
    [
      "-ldflags",
      "-extldflags '-Xlinker --sysroot=private-sdk'",
      ["private-sdk"],
    ],
    [
      "-ldflags",
      "-extldflags '-Xlinker --sysroot -Xlinker private-sdk'",
      ["private-sdk"],
    ],
    ["CGO_LDFLAGS", "-Wl,--sysroot=private-sdk", ["private-sdk"]],
    ["CGO_LDFLAGS", "-Wl,-Map=-", []],
    ["-ldflags", "-extldflags=-Wl,-Map=-", []],
    [
      "-ldflags",
      "-s -w -extldflags=-Wl,--version-script=private-versions.map",
      ["private-versions.map"],
    ],
    [
      "-ldflags",
      "-extldflags '-Wl,--version-script,private-versions.map'",
      ["private-versions.map"],
    ],
    [
      "-ldflags",
      "-extldflags '-Wl,--dynamic-list=exports.list'",
      ["exports.list"],
    ],
    [
      "-ldflags",
      "-s -w -extldflags=-Wl,-Map=private-link.map",
      ["private-link.map"],
    ],
    [
      "-ldflags",
      "-extldflags '-Wl,-Map,private-link.map'",
      ["private-link.map"],
    ],
    [
      "-ldflags",
      "-extldflags=-Wl,--just-symbols=private.syms",
      ["private.syms"],
    ],
    [
      "-ldflags",
      "-extldflags '-Wl,--just-symbols,private.syms'",
      ["private.syms"],
    ],
    [
      "-ldflags",
      "-extldflags '-Xlinker --just-symbols -Xlinker private.syms'",
      ["private.syms"],
    ],
    ["CGO_CFLAGS", "-I-", []],
    [
      "CGO_CFLAGS",
      "-Iprivate-sdk -I- -I vendor/sdk",
      ["private-sdk", "vendor/sdk"],
    ],
    [
      "CGO_CFLAGS",
      "-Iprivate-sdk -O2 -isystem vendor/sdk",
      ["private-sdk", "vendor/sdk"],
    ],
    ["CGO_LDFLAGS", "-Llibs -lssl", ["libs"]],
    [
      "CGO_LDFLAGS",
      "-Wl,-Bstatic,-lssl,-Bdynamic -Xlinker -Bsymbolic -Wl,-Ttext=0x400000,-Tdata,0x600000 -Xlinker -Ttext-segment=0x10000",
      [],
    ],
  ];
  it.for(cases)("interprets %s=%s", checkPathCase);
});
