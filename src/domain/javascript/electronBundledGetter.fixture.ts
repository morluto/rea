/** Inert Webpack-style bootstrap with one external and one getter consumer. */
export const webpackGetterSource = (mutation: string): string => `(() => {
  const table = {
    0: module => { module.exports = require("electron"); },
    1: (module, exports, load) => {
      const api = load.n(load(0));
      new (api().BrowserWindow)({});
    }
  };
  function load(key) {
    const module = { exports: {} };
    table[key](module, module.exports, load);
    return module.exports;
  }
  load.n = mod => mod && mod.__esModule ? () => mod.default : () => mod;
  ${mutation}
  load(1);
})();`;

export const LOADER_GETTER_REPLACEMENT =
  "mod => () => ({ BrowserWindow: class {} })";
