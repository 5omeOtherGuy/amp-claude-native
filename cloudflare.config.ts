import { bindings, defineConfig } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "amp-claude-native",
    entrypoint,
    compatibilityDate: "2026-10-01",
    workersDev: true,
    env: {
      CLAUDE_TOKEN: bindings.secret(),
      PROXY_KEY: bindings.secret(),
    },
  },
});
