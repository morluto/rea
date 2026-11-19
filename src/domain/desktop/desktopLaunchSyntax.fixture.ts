/** Raw slices around the program, plus the host's interpretation. */
export const DESKTOP_LAUNCH_CASES: readonly {
  name: string;
  prefix: string;
  program: string;
  suffix: string;
  decodedProgram: string;
  environment: Readonly<Record<string, string>>;
  clear?: true;
  chdir?: {
    path: string;
    start: number;
    end: number;
    includesClearEnvironment?: true;
  };
}[] = [
  {
    name: "direct command",
    prefix: "",
    program: "drawio",
    suffix: " %U",
    decodedProgram: "drawio",
    environment: {},
  },
  {
    name: "quoted wrapper and value escapes before the program",
    prefix: String.raw`"/usr/bin/env" -- "GTK_THEME=\sAdwaita\\\\😀" `,
    program: '"draw.io for Linux"',
    suffix: '\t--title="drawing"  %U',
    decodedProgram: "draw.io for Linux",
    environment: { GTK_THEME: " Adwaita\\😀" },
  },
  {
    name: "separate clean and chdir operands",
    prefix: 'env -i -C "/tmp/work folder" -- A=old A=new ',
    program: "drawio",
    suffix: " --ignore-environment %U",
    decodedProgram: "drawio",
    environment: { A: "new" },
    clear: true,
    chdir: { path: "/tmp/work folder", start: 2, end: 4 },
  },
  {
    name: "combined clean and chdir option",
    prefix: "env -iiC/tmp -- ",
    program: "drawio",
    suffix: " %U",
    decodedProgram: "drawio",
    environment: {},
    clear: true,
    chdir: { path: "/tmp", start: 1, end: 2, includesClearEnvironment: true },
  },
  {
    name: "long clean option",
    prefix: "env --ignore-environment QT_QPA_PLATFORM=xcb ",
    program: "drawio",
    suffix: " %U",
    decodedProgram: "drawio",
    environment: { QT_QPA_PLATFORM: "xcb" },
    clear: true,
  },
  {
    name: "dash reset after option terminator",
    prefix: "env -- - ",
    program: "drawio",
    suffix: " %U",
    decodedProgram: "drawio",
    environment: {},
    clear: true,
  },
  {
    name: "last chdir option overrides an empty attached operand",
    prefix: "env --chdir= -C /old --chdir=/tmp -- ",
    program: "drawio",
    suffix: " %U",
    decodedProgram: "drawio",
    environment: {},
    chdir: { path: "/tmp", start: 4, end: 5 },
  },
  {
    name: "option-looking program after an assignment",
    prefix: "env MODE=selected ",
    program: "--",
    suffix: " drawio %U",
    decodedProgram: "--",
    environment: { MODE: "selected" },
  },
];
