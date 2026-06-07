import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const livekitRegistryDist = join(
  repoRoot,
  'agents/livekit/dist/lib/livekit-model-registry.js',
);

export default () => {
  // The livekit registry is only needed by suites that import it. In single-agent
  // container builds (e.g. the jambonz image) the agents/livekit source tree isn't
  // present, so attempting `yarn build` there fails with a bogus spawn ENOENT
  // (non-existent cwd). Only build when the source package is actually checked out.
  const livekitPkg = join(repoRoot, 'agents/livekit/package.json');
  if (!existsSync(livekitRegistryDist) && existsSync(livekitPkg)) {
    execSync('yarn build', {
      cwd: join(repoRoot, 'agents/livekit'),
      stdio: 'inherit',
    });
  }
  dotenv.config();
  // Nuke all the database config because we are using a test database container even in a real environment
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('POSTGRES_')) {
      delete process.env[key];
    }
  });
};

