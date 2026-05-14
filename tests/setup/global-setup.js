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
  if (!existsSync(livekitRegistryDist)) {
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

