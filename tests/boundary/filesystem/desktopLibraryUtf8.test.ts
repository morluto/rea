import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectLibraryPackages } from "../../../src/desktop/LibraryPackageInventory.js";
import { elfImage } from "../../../src/domain/desktop/elfImage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** A real filesystem walk, with only the host package database replaced. */
const inventory = async (executable: string, selected: string) => {
  const queried: string[] = [];
  const result = await inspectLibraryPackages(
    executable,
    "app",
    async (command, args) => {
      if (command === "ldconfig") return { stdout: "", exitCode: 0 };
      queried.push(...args.slice(1));
      return {
        stdout: args
          .slice(1)
          .map(
            (path) =>
              `${path === selected ? "selected-owner" : "decoy-owner"}: ${path}`,
          )
          .join("\n"),
        exitCode: 0,
      };
    },
    undefined,
  );
  return { result, queried };
};

const writeImage = async (path: string, image: Buffer) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, image);
};

const invalidNameImage = () => {
  const image = elfImage({ needed: ["libX.so"] });
  image[image.indexOf(Buffer.from("libX.so")) + 3] = 0xff;
  return image;
};

describe.skipIf(process.platform === "win32")(
  "ELF filesystem string identities",
  () => {
    it.each(["libé.so", "lib选择.so", "\uFEFFlib.so", "lib\uFFFD.so"])(
      "queries the actual UTF-8 library %s, even when a Latin-1 decoy exists",
      async (name) => {
        const root = await createTestTempDirectory("rea-library-utf8-");
        const executable = join(root, "bin", "app");
        const selected = join(root, "lib", name);
        const decoy = join(root, "lib", Buffer.from(name).toString("latin1"));
        await writeImage(
          executable,
          elfImage({ needed: [name], runpath: "$ORIGIN/../lib" }),
        );
        await writeImage(selected, elfImage({}));
        await writeImage(decoy, elfImage({ needed: ["libdecoy-only.so"] }));

        const { result, queried } = await inventory(executable, selected);
        expect(result).toEqual({
          library_packages: ["selected-owner"],
          missing_libraries: [],
          unpackaged_libraries: [],
        });
        expect(queried).toEqual([selected]);
      },
    );

    it.each(["rpath", "runpath"] as const)(
      "uses the original UTF-8 %s rather than the existing mojibake directory",
      async (tag) => {
        const root = await createTestTempDirectory("rea-library-utf8-path-");
        const executable = join(root, "bin", "app");
        const selected = join(root, "库", "libchoice.so");
        const decoy = join(
          root,
          Buffer.from("库").toString("latin1"),
          "libchoice.so",
        );
        await writeImage(
          executable,
          elfImage({ needed: ["libchoice.so"], [tag]: "$ORIGIN/../库" }),
        );
        await writeImage(selected, elfImage({}));
        await writeImage(decoy, elfImage({ needed: ["libdecoy-only.so"] }));

        const { result, queried } = await inventory(executable, selected);
        expect(result).toEqual({
          library_packages: ["selected-owner"],
          missing_libraries: [],
          unpackaged_libraries: [],
        });
        expect(queried).toEqual([selected]);
      },
    );

    it("reads UTF-8 dependencies and search paths of a selected transitive library", async () => {
      const root = await createTestTempDirectory(
        "rea-library-utf8-transitive-",
      );
      const executable = join(root, "bin", "app");
      const parent = join(root, "bin", "libparent.so");
      const selected = join(root, "库", "libé.so");
      await writeImage(
        executable,
        elfImage({ needed: ["libparent.so"], runpath: "$ORIGIN" }),
      );
      await writeImage(
        parent,
        elfImage({ needed: ["libé.so"], runpath: "$ORIGIN/../库" }),
      );
      await writeImage(selected, elfImage({}));

      const { result, queried } = await inventory(executable, selected);
      expect(result).toEqual({
        library_packages: ["selected-owner"],
        missing_libraries: [],
        unpackaged_libraries: [],
      });
      expect(queried).toEqual([selected]);
    });

    it("leaves invalid source bytes unknown instead of querying a Latin-1 or replacement-character decoy", async () => {
      const root = await createTestTempDirectory("rea-library-invalid-utf8-");
      const executable = join(root, "bin", "app");
      await writeImage(executable, invalidNameImage());
      for (const name of ["libÿ.so", "lib\uFFFD.so"])
        await writeImage(join(root, "bin", name), elfImage({}));

      const { result, queried } = await inventory(executable, "");
      expect(result).toEqual({
        library_packages: [],
        missing_libraries: [],
        unpackaged_libraries: [],
        library_packages_reason: expect.stringContaining(
          "filesystem identity is unresolved",
        ),
      });
      expect(queried).toEqual([]);
    });

    it("retains a compatible library's package when its transitive filename cannot be represented", async () => {
      const root = await createTestTempDirectory(
        "rea-library-invalid-transitive-",
      );
      const executable = join(root, "bin", "app");
      const selected = join(root, "lib", "libparent.so");
      await writeImage(
        executable,
        elfImage({ needed: ["libparent.so"], runpath: "$ORIGIN/../lib" }),
      );
      await writeImage(selected, invalidNameImage());

      const { result, queried } = await inventory(executable, selected);
      expect(result).toEqual({
        library_packages: ["selected-owner"],
        missing_libraries: [],
        unpackaged_libraries: [],
        library_packages_reason: expect.stringContaining(
          "filesystem identity is unresolved",
        ),
      });
      expect(queried).toEqual([selected]);
    });
  },
);
