import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
