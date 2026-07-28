import type { Options } from 'tsup';

const defaultOptions: Options = {
  // Match plugin sources only: a broader `plugins/**/*.ts` also picks up a
  // plugin's own node_modules/ and dist/, and esbuild fails on the .d.ts files
  // it finds there.
  entry: ["./realtime.ts", "lib/*.ts", "plugins/*/src/**/*.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: true,
  // for the type maps to work, we use tsc's declaration-only command on the success callback
  dts: false,
  clean: true,
  target: "node16",
  bundle: false,
  shims: true,
  esbuildOptions: (options, context) => {
    if (context.format === "esm") {
      options.packages = "external";
    }
  },
  external: [
    "agent-lib/logger.js",
    "agent-lib/database.js",
    "agent-lib/function-handler.js",
  ],
  onSuccess: "mkdir -p dist/agent-lib && cp -rp agent-lib/* dist/agent-lib/",
};
export default defaultOptions;


