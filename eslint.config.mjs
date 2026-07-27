const nodeGlobals = {
  __dirname: "readonly",
  AbortController: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  global: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly"
};

const browserGlobals = {
  CustomEvent: "readonly",
  document: "readonly",
  Event: "readonly",
  FormData: "readonly",
  HTMLElement: "readonly",
  Intl: "readonly",
  URL: "readonly",
  window: "readonly"
};

export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"]
  },
  {
    files: ["electron/**/*.cjs", "scripts/**/*.cjs", "test/**/*.cjs", "smoke/**/*.cjs", "electron-builder.config.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: nodeGlobals
    },
    rules: {
      eqeqeq: "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals
    },
    rules: {
      eqeqeq: "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["test/renderer.test.cjs", "smoke/**/*.cjs"],
    languageOptions: {
      globals: browserGlobals
    }
  }
];
