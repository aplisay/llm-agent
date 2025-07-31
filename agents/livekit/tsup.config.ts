import type { Options } from 'tsup';

const defaultOptions: Options = {
  entry: ['./realtime.ts', 'lib/**/*.ts', 'plugins/**/*.ts', 'agent-lib/**/*.js'],
  format: ['esm'],
  splitting: false,
  sourcemap: true,
  // for the type maps to work, we use tsc's declaration-only command on the success callback
  dts: false,
  clean: true,
  target: 'node16',
  bundle: false,
  shims: true,
  legacyOutput: true,
  esbuildOptions: (options, context) => {
    if (context.format === 'esm') {
      options.packages = 'external';
    }
  },
  external: ['agent-lib/logger.js', 'agent-lib/database.js', 'agent-lib/function-handler.js'],
  onSuccess: 'find agent-lib -type f -name "*.js" -exec cp {} dist/agent-lib/`basename {}`.cjs \\;',

};
export default defaultOptions;


