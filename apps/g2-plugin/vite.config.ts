import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const version = (JSON.parse(readFileSync(new URL("./app.json", import.meta.url), "utf8")) as { version: string }).version;

export default defineConfig({
  define: { __HELIX_VERSION__: JSON.stringify(version) },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "esnext",
  },
});
