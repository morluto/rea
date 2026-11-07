import type { WithheldFile } from "./appWithheld.js";

const homeList = (paths: readonly string[]) =>
  paths.map((path) => `\`~/${path}\``).join(", ");

/** The env.toml lines that set each withheld file's setting to its environment variable; none without any. */
export const withheldToml = (withheld: readonly WithheldFile[]): string[] =>
  withheld.length === 0
    ? []
    : [
        "",
        "[settings]",
        ...withheld.map(
          ({ setting, variable }) =>
            `${setting} = ${JSON.stringify(`env:${variable}`)}`,
        ),
      ];

/** The class's settings: each withheld file, its bytes in base64, a secret no record keeps; built with real types, since the module's annotations stay strings. */
export const withheldSettingsClass = (
  withheld: readonly WithheldFile[],
): string =>
  withheld.length === 0
    ? ""
    : `
    #: Files withheld from the seed as sign-in or licence state, each its bytes in base64, from the environment.
    Settings = create_model("Settings", __base__=ComputerAppEnvironment.Settings, ${withheld.map(({ setting }) => `${setting}=(SecretStr, ...)`).join(", ")})
`;

/** The README lines on withheld sign-in state: each file's variable and how to fill it, and what was seeded with consent. */
export const withheldNotes = ({
  withheld = [],
  consentedFiles = [],
}: {
  readonly withheld?: readonly WithheldFile[] | undefined;
  readonly consentedFiles?: readonly string[] | undefined;
}): string =>
  [
    ...(withheld.length === 0
      ? []
      : [
          `\n- Withheld from the seed as sign-in or licence state: ${homeList(withheld.map(({ file }) => file))}. A deploy refuses to
  start until each is in its environment variable as the file's bytes in base64, taken from your own signed-in copy of
  the app; the computer writes it into its home before the app first starts, and \`data/get\` never serves it:${withheld
    .map(
      ({ file, variable }) =>
        `\n\n      export ${variable}="$(base64 -w0 < ~/${file})"`,
    )
    .join("")}\n`,
        ]),
    ...(consentedFiles.length === 0
      ? []
      : [
          `\n- Seeded with the person's consent, as \`consent.json\` records, though it is sign-in or licence state:
  ${homeList(consentedFiles)}. Keep this bundle to those the person allowed.`,
        ]),
  ].join("");
