import type { Options } from 'tsup';

const defaultOptions: Options = {
<<<<<<< HEAD
  entry: ["./realtime.ts", "lib/*.ts", "plugins/**/*.ts"],
  format: ["esm"],
=======
  entry: ['./realtime.ts', 'lib/**/*.ts', 'plugins/**/*.ts', 'agent-lib/**/*.js'],
  format: ['esm'],
>>>>>>> 28b3218 (Refactor project to ESM)
  splitting: false,
  sourcemap: true,
  // for the type maps to work, we use tsc's declaration-only command on the success callback
  dts: false,
  clean: true,
  target: "node16",
  bundle: false,
  shims: true,
  legacyOutput: true,
  esbuildOptions: (options, context) => {
    if (context.format === "esm") {
      options.packages = "external";
    }
  },
<<<<<<< HEAD
  external: [
    "agent-lib/logger.js",
    "agent-lib/database.js",
    "agent-lib/function-handler.js",
  ],
  onSuccess: "mkdir -p dist/agent-lib && cp -rp agent-lib/* dist/agent-lib/",
=======
  external: ['agent-lib/logger.js', 'agent-lib/database.js', 'agent-lib/function-handler.js'],
  onSuccess: 'find agent-lib -type f -name "*.js" -exec cp {} dist/agent-lib/`basename {}`.cjs \\;',

>>>>>>> 28b3218 (Refactor project to ESM)
};
export default defaultOptions;


