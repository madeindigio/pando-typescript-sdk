import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PANDO-US-0006 acceptance fixture. A plain Vite + React 18 client build with
// no Node polyfills configured on purpose: the point of this fixture is to
// prove `@pando-ai/sdk/agui/client` needs none.
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    // Keep the smoke test's output readable when someone inspects dist/
    // manually; the run.mjs assertions do not depend on this either way.
    minify: false,
  },
});
