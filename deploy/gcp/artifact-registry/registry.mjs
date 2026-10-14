// Shared helpers for the `containers` repository cleanup scripts.

import { execFileSync } from 'node:child_process';

export const PROJECT = 'llm-voice';
export const LOCATION = 'europe-west1';
export const REPO = 'containers';
export const HOST = `${LOCATION}-docker.pkg.dev/${PROJECT}/${REPO}/`;
export const API = `https://artifactregistry.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/repositories/${REPO}`;

// Packages the cleanup may touch. Must match packageNamePrefixes in cleanup-policy.json.
export const SCOPE = ['llm-agent', 'polite-ai-website'];
export const inScope = pkg => SCOPE.some(p => pkg.startsWith(p));

export const BETA_KEEP_LAST = 3;
export const BETA_KEEP_DAYS = 14;

let token;
export async function accessToken() {
  if (token) return token;
  try {
    // Cloud Build and other GCP runtimes: the metadata server.
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) });
    if (res.ok) return (token = (await res.json()).access_token);
  } catch {}
  return (token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim());
}

export async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function listAll(resource) {
  const out = [];
  let page = '';
  do {
    const body = await api(`/${resource}?pageSize=1000${page ? `&pageToken=${page}` : ''}`);
    out.push(...(body[resource] ?? []));
    page = body.nextPageToken;
  } while (page);
  return out;
}

// `attachment` marks Cloud Build provenance manifests. The registry deletes
// them with the image they describe and leaves them out of mostRecentVersions.
// The daily prune passes attachments: false: its account cannot list them.
export async function listImages({ attachments = true } = {}) {
  const attached = new Set(attachments
    ? (await listAll('attachments')).map(a => a.ociVersionName?.split('/versions/')[1]) : []);
  return (await listAll('dockerImages')).map(i => {
    const [pkg, digest] = i.uri.slice(HOST.length).split('@');
    return { pkg, digest, tags: i.tags ?? [], created: Date.parse(i.uploadTime), updated: Date.parse(i.updateTime),
      bytes: +i.imageSizeBytes, attachment: attached.has(digest) };
  });
}

const betaNum = t => t.slice(5).split('.').map(Number);
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };

// The beta-* tags to remove so that each package keeps its 3 newest betas or
// every beta from the last 14 days, whichever is more. A version's updateTime
// moves when :beta moves off it, so max(create, update) is no earlier than the
// time it stopped being the live beta.
export function betaTagsToRemove(images, now = Date.now()) {
  const out = [];
  const byPkg = Map.groupBy(images.filter(v => inScope(v.pkg) && v.tags.some(t => /^beta-\d/.test(t))), v => v.pkg);
  for (const vs of byPkg.values()) {
    const top = v => v.tags.filter(t => /^beta-\d/.test(t)).map(betaNum).sort(cmp).at(-1);
    vs.sort((a, b) => cmp(top(b), top(a)));
    vs.forEach((v, i) => {
      if (i < BETA_KEEP_LAST) return;
      if (now - Math.max(v.created, v.updated) < BETA_KEEP_DAYS * 864e5) return;
      // The live beta, releases and channel heads stay tagged whatever their age.
      if (v.tags.some(t => t === 'beta' || /^(v|next|staging|latest)/.test(t))) return;
      for (const tag of v.tags.filter(t => /^beta-\d/.test(t))) out.push({ v, tag });
    });
  }
  return out;
}
