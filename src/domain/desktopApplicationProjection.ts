import { IL2CPP_METADATA_VERSIONS } from "./il2cpp/il2cppMetadata.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { desktopPathConventions } from "./nativeConvention.js";
import type { DesktopApplication, DesktopFile } from "./desktopApplication.js";

/** The most next probes this projection derives from any one fact. */
export const DESKTOP_PROBES_PER_FACT = 2;

const IL2CPP_METADATA_VERSION_SET = new Set<number>(IL2CPP_METADATA_VERSIONS);

const COMPONENT_MARKERS = [
  {
    expression: /(?:^|\/)bepinex(?:\/|$)/iu,
    name: "BepInEx",
    category: "mod-loader" as const,
  },
  {
    expression: /(?:^|\/)melonloader(?:\/|$)/iu,
    name: "MelonLoader",
    category: "mod-loader" as const,
  },
  {
    expression: /(?:^|\/)easyanticheat(?:_eos)?(?:\/|$)/iu,
    name: "Easy Anti-Cheat",
    category: "protection" as const,
  },
  {
    expression: /(?:^|\/)battleye(?:\/|$)/iu,
    name: "BattlEye",
    category: "protection" as const,
  },
  // Native UI stacks and runtimes, by the file names their releases ship.
  {
    expression:
      /(?:^|\/)(?:(?:lib)?qt[56]?core[^/]*\.(?:dll|so(?:\.[0-9]+)*|dylib)|qtcore\.framework|platforms\/(?:lib)?q(?:windows|xcb|cocoa|wayland[^/]*|offscreen|minimal)[^/]*\.(?:dll|so|dylib)|qt\.conf)$/iu,
    name: "Qt",
    category: "ui-framework" as const,
  },
  {
    expression:
      /(?:^|\/)(?:lib)?sdl[23]?(?:-[0-9.]+)?\.(?:dll|so(?:\.[0-9]+)*|dylib)$|(?:^|\/)sdl[23]\.framework$/iu,
    name: "SDL",
    category: "ui-framework" as const,
  },
  {
    expression:
      /(?:^|\/)(?:lib)?wx_?(?:msw|gtk[23]u?|base|osx)[^/]*\.(?:dll|so(?:\.[0-9]+)*|dylib)$/iu,
    name: "wxWidgets",
    category: "ui-framework" as const,
  },
  {
    expression: /(?:^|\/)libgtk-[34][^/]*\.(?:dll|so(?:\.[0-9]+)*|dylib)$/iu,
    name: "GTK",
    category: "ui-framework" as const,
  },
  {
    expression:
      /(?:^|\/)(?:vcruntime140(?:_1)?|msvcp140(?:_[0-9a-z_]+)?|concrt140|ucrtbase)\.dll$/iu,
    name: "Microsoft Visual C++ runtime",
    category: "runtime-library" as const,
  },
] as const;

/** Runtime facades a self-contained .NET or Mono release ships beside its own code. */
const RUNTIME_FACADE =
  /^(?:system(?:\..+)?|microsoft\..+|mscorlib|netstandard|windowsbase|presentationcore|presentationframework|presentationui|reachframework|accessibility|uiautomation[^/]*|directwriteforwarder|mono\..+|unityengine(?:\..+)?)\.dll$/iu;

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);
const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};
const stemOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
};

/**
 * Stems the release names as its own code: a host's `<name>.runtimeconfig.json`
 * or `<name>.deps.json`, and an assembly shipped with its `<name>.pdb`.
 */
const applicationStems = (files: readonly DesktopFile[]): Set<string> => {
  const stems = new Set<string>();
  for (const file of files) {
    if (file.kind !== "file") continue;
    const name = baseName(file.path).toLowerCase();
    const directory = directoryOf(file.path).toLowerCase();
    for (const suffix of [".runtimeconfig.json", ".deps.json", ".pdb"])
      if (name.endsWith(suffix) && name.length > suffix.length)
        stems.add(`${directory}/${name.slice(0, -suffix.length)}`);
  }
  return stems;
};

/** Native executables a release starts from: the shallowest PE .exe or extensionless ELF/Mach-O images. */
const mainExecutables = (files: readonly DesktopFile[]): DesktopFile[] => {
  const executables = files.filter((file) =>
    file.facts.some((fact) => {
      if (fact.kind !== "native-image-header") return false;
      const name = baseName(file.path).toLowerCase();
      return fact.value.format === "pe"
        ? name.endsWith(".exe")
        : !/\.(?:so(?:\.[0-9]+)*|dylib|dll|bundle|node)$/u.test(name);
    }),
  );
  const depth = (file: DesktopFile): number => file.path.split("/").length;
  const shallowest = Math.min(...executables.map(depth));
  return executables.filter((file) => depth(file) === shallowest);
};

const classifyDesktopFiles = (files: readonly DesktopFile[]) => {
  const managed: DesktopFile[] = [];
  const mono: DesktopFile[] = [];
  const monoDirectories = new Set<string>();
  const managedIl2cppBackup: DesktopFile[] = [];
  const metadata: DesktopFile[] = [];
  const supportedMetadata: DesktopFile[] = [];
  const il2cpp: DesktopFile[] = [];
  const godot: DesktopFile[] = [];
  const unityfs: DesktopFile[] = [];
  const gamemaker: DesktopFile[] = [];
  const unreal: DesktopFile[] = [];
  const electron: DesktopFile[] = [];
  const markerBasis: DesktopFile[][] = COMPONENT_MARKERS.map(() => []);

  for (const file of files) {
    let hasCli = false;
    let hasUnityRef = false;
    let hasIl2cppBackup = false;
    let hasMetadata = false;
    let hasSupportedMetadata = false;
    let hasIl2cppLib = false;
    let hasNativeImage = false;
    let hasGodot = false;
    let hasUnityfs = false;
    let hasGamemaker = false;
    let hasUnreal = false;
    let hasElectron = false;

    for (const fact of file.facts) {
      switch (fact.kind) {
        case "pe-cli-directory":
          hasCli = true;
          break;
        case "unity-assembly-reference":
          hasUnityRef = true;
          break;
        case "unity-il2cpp-backup-convention":
          hasIl2cppBackup = true;
          break;
        case "il2cpp-metadata-header":
          hasMetadata = true;
          if (
            fact.value.raw_version !== null &&
            IL2CPP_METADATA_VERSION_SET.has(fact.value.raw_version)
          )
            hasSupportedMetadata = true;
          break;
        case "il2cpp-library-convention":
          hasIl2cppLib = true;
          break;
        case "native-image-header":
          hasNativeImage = true;
          break;
        case "godot-pck-header":
          hasGodot = true;
          break;
        case "unityfs-header":
          hasUnityfs = true;
          break;
        case "gamemaker-form-header":
          hasGamemaker = true;
          break;
        case "unreal-container-convention":
          hasUnreal = true;
          break;
        case "electron-asar-convention":
          hasElectron = true;
          break;
      }
    }

    if (hasCli) {
      managed.push(file);
      if (hasUnityRef) {
        mono.push(file);
        for (const fact of file.facts)
          if (fact.kind === "unity-assembly-reference")
            monoDirectories.add(fact.value.managed_directory);
      }
      if (hasIl2cppBackup) managedIl2cppBackup.push(file);
    }
    if (hasMetadata) {
      metadata.push(file);
      if (hasSupportedMetadata) supportedMetadata.push(file);
    }
    if (hasIl2cppLib && hasNativeImage) il2cpp.push(file);
    if (hasGodot) godot.push(file);
    if (hasUnityfs) unityfs.push(file);
    if (hasGamemaker) gamemaker.push(file);
    if (hasUnreal) unreal.push(file);
    if (hasElectron) electron.push(file);
    for (let i = 0; i < COMPONENT_MARKERS.length; i++)
      if (COMPONENT_MARKERS[i]!.expression.test(file.path))
        markerBasis[i]!.push(file);
  }

  return {
    managed,
    mono,
    monoDirectories,
    managedIl2cppBackup,
    metadata,
    supportedMetadata,
    il2cpp,
    godot,
    unityfs,
    gamemaker,
    unreal,
    electron,
    markerBasis,
  };
};

/** Interpret only the facts admitted by the directory reader, never target bytes. */
export const projectDesktopApplication = (
  files: readonly DesktopFile[],
): Pick<
  DesktopApplication,
  "candidates" | "components" | "next_probes" | "deferred_probes"
> => {
  const candidates: DesktopApplication["candidates"] = [];
  const components: DesktopApplication["components"] = [];
  const probes = new Map<string, DesktopApplication["next_probes"][number]>();
  const deferred = new Map<
    string,
    DesktopApplication["deferred_probes"][number]
  >();
  const candidate = (
    family: DesktopApplication["candidates"][number]["family"],
    basis: readonly DesktopFile[],
    rationale: string,
    confidence: "derived" | "inferred" = "derived",
  ) => {
    if (basis.length === 0) return;
    const semantic = {
      family,
      basis_file_ids: [...new Set(basis.map((file) => file.file_id))].sort(),
      rationale,
      confidence,
    };
    candidates.push({
      candidate_id: `dsc_${digestCanonicalValue(semantic, "Desktop runtime candidate")}`,
      ...semantic,
    });
  };
  const probe = (
    operation: DesktopApplication["next_probes"][number]["operation"],
    file: DesktopFile,
    rationale: string,
    priority: DesktopApplication["next_probes"][number]["priority"] = "dependency",
  ) => {
    const semantic = {
      operation,
      path: file.local_path,
      file_id: file.file_id,
      rationale,
      confidence: "inferred" as const,
      priority,
    };
    const probe_id = `dsp_${digestCanonicalValue(semantic, "Desktop next probe")}`;
    probes.set(probe_id, { probe_id, ...semantic });
  };

  const {
    managed,
    mono,
    monoDirectories,
    managedIl2cppBackup,
    metadata,
    supportedMetadata,
    il2cpp,
    godot,
    unityfs,
    gamemaker,
    unreal,
    electron,
    markerBasis,
  } = classifyDesktopFiles(files);

  candidate(
    "dotnet",
    managed,
    "PE optional headers declare nonempty CLI directories; CLR execution and metadata validity remain unverified.",
  );
  if (monoDirectories.size > 0) {
    for (const file of managed) {
      const conventions = desktopPathConventions(file.path);
      if (
        conventions.unityPredefinedAssembly &&
        conventions.unityManagedDirectory !== null &&
        monoDirectories.has(conventions.unityManagedDirectory)
      )
        probe(
          "inspect_managed_members",
          file,
          'Inventory types, members and user strings of this Unity predefined script assembly; its references and contents are unverified. Start with detail "summary" and page rows through inspect_analysis_view.',
          "application",
        );
    }
  }
  for (const file of managedIl2cppBackup)
    probe(
      "inspect_managed_members",
      file,
      'Inventory types, members and user strings of this predefined script assembly in a Unity IL2CPP backup folder; its correspondence to the shipped native code is unknown. Start with detail "summary" and page rows through inspect_analysis_view.',
      "application",
    );
  const ownStems = applicationStems(files);
  const isOwn = (file: DesktopFile): boolean =>
    ownStems.has(
      `${directoryOf(file.path).toLowerCase()}/${stemOf(baseName(file.path)).toLowerCase()}`,
    );
  for (const file of [...managed].sort(
    (left, right) => Number(isOwn(right)) - Number(isOwn(left)),
  )) {
    if (isOwn(file)) {
      probe(
        "inspect_managed_artifact",
        file,
        "Inspect the declared managed metadata and references of an assembly this release names as its own (a matching .runtimeconfig.json, .deps.json or .pdb).",
        "application",
      );
      continue;
    }
    if (RUNTIME_FACADE.test(baseName(file.path))) {
      const group = deferred.get("inspect_managed_artifact");
      if (group === undefined)
        deferred.set("inspect_managed_artifact", {
          operation: "inspect_managed_artifact",
          reason: "runtime-facade",
          count: 1,
          example_file_id: file.file_id,
          rationale:
            "Runtime and framework assemblies (System.*, Microsoft.*, mscorlib, netstandard, UnityEngine and similar) shipped beside the application; inspect one only when the question concerns the runtime itself.",
        });
      else
        deferred.set("inspect_managed_artifact", {
          ...group,
          count: group.count + 1,
        });
      continue;
    }
    probe(
      "inspect_managed_artifact",
      file,
      "Inspect the declared managed metadata and references.",
    );
  }
  candidate(
    "unity-mono",
    mono,
    "Managed assemblies in a Unity Data/Managed layout reference UnityEngine assemblies.",
  );
  for (const file of supportedMetadata)
    probe(
      "inspect_il2cpp_metadata",
      file,
      "Inventory this supported-version metadata candidate; complete validity and native binary correspondence remain unverified.",
    );
  if (metadata.length > 0 && il2cpp.length > 0) {
    candidate(
      "unity-il2cpp",
      [...metadata, ...il2cpp],
      "IL2CPP metadata magic and conventionally named native libraries coexist; metadata validity and build correspondence are unverified.",
      "inferred",
    );
    for (const file of il2cpp)
      probe(
        "open_binary",
        file,
        "Inspect this native IL2CPP candidate; metadata-to-address correspondence remains unknown.",
      );
  }
  candidate(
    "godot",
    godot,
    "A standalone or trailer-located Godot pack header was observed; pack contents and encryption are unexamined.",
  );
  for (const file of godot)
    probe(
      "open_binary",
      file,
      "Select this Godot pack carrier with open_binary, then call inspect_artifact to inventory its members, including a pack embedded in an executable's trailer; encrypted packs report their members as unavailable.",
      "application",
    );
  for (const file of unityfs)
    probe(
      "open_binary",
      file,
      "A UnityFS AssetBundle header was observed; member contents and encryption are unexamined.",
    );
  candidate(
    "gamemaker",
    gamemaker,
    "A FORM container begins with a GEN8 chunk; its game resources remain unexamined.",
  );
  candidate(
    "unreal",
    unreal,
    "Unreal Content/Paks paths or an IoStore TOC header suggest an Unreal package layout.",
    "inferred",
  );
  candidate(
    "electron",
    electron,
    "An app.asar in a resources directory suggests an Electron application; archive validity and execution are unverified.",
    "inferred",
  );
  for (const file of electron) {
    probe(
      "open_binary",
      file,
      "Select this ASAR target with open_binary, then call inspect_artifact to inventory it before selecting JavaScript sources.",
    );
    probe(
      "analyze_javascript_application",
      file,
      "Analyze the candidate application archive with the static JavaScript workflow.",
    );
  }
  if (candidates.length === 0) {
    const mains = mainExecutables(files);
    candidate(
      "native",
      mains,
      "Native executable headers were observed and no recognised managed, engine or Electron runtime; the UI stack is reported by component markers, and the code is unexamined.",
      "inferred",
    );
    for (const file of mains) {
      const pe = file.facts.some(
        (fact) =>
          fact.kind === "native-image-header" && fact.value.format === "pe",
      );
      if (pe) {
        probe(
          "inspect_pe_imports",
          file,
          "List the DLLs and functions this executable imports; they name its UI, graphics and platform dependencies.",
          "application",
        );
        probe(
          "inspect_pe_resources",
          file,
          "Inventory the resource tree this executable declares (types, names, languages, ranges and hashes); payloads other than group icons stay opaque.",
          "application",
        );
      } else {
        probe(
          "inspect_binary_hardening",
          file,
          "Report this executable's hardening and linkage declarations.",
          "application",
        );
        probe(
          "open_binary",
          file,
          "Open this native executable for deeper analysis.",
          "application",
        );
      }
    }
  }
  for (let i = 0; i < COMPONENT_MARKERS.length; i++) {
    const basis = markerBasis[i]!;
    if (basis.length === 0) continue;
    const marker = COMPONENT_MARKERS[i]!;
    const semantic = {
      name: marker.name,
      category: marker.category,
      basis_file_ids: basis.map((file) => file.file_id),
      confidence: "inferred" as const,
      runtime_presence: "unknown" as const,
    };
    components.push({
      component_id: `dsm_${digestCanonicalValue(semantic, "Desktop component marker")}`,
      ...semantic,
    });
  }
  // Stable within each priority; application probes first.
  const ordered = [...probes.values()].sort(
    (left, right) =>
      Number(right.priority === "application") -
      Number(left.priority === "application"),
  );
  return {
    candidates,
    components,
    next_probes: ordered,
    deferred_probes: [...deferred.values()],
  };
};
