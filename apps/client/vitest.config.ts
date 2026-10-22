// The Expo client package is CommonJS (babel.config.js / metro.config.js use
// module.exports), so this config is written in CommonJS form to avoid an
// ESM-in-CJS warning from the Vite config loader.
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
