// tsup onSuccess: copy agent-lib/ into dist/agent-lib/.
// A symlink that resolves is copied as its target: copied as a link, it would
// point one level too high from dist/ (GNU cp -rp did this on Linux checkouts).
// A link that does not resolve (in the image, lib/ dirs are not at the link
// target) is copied as a link, as before.
import fs from 'node:fs';
import path from 'node:path';

const src = 'agent-lib';
const dest = path.join('dist', 'agent-lib');
fs.mkdirSync(dest, { recursive: true });

for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  const to = path.join(dest, name);
  let resolves = true;
  try {
    fs.statSync(from);
  } catch {
    resolves = false;
  }
  fs.rmSync(to, { recursive: true, force: true });
  if (resolves) {
    fs.cpSync(from, to, { recursive: true, dereference: true, preserveTimestamps: true });
  } else {
    fs.symlinkSync(fs.readlinkSync(from), to);
  }
}
