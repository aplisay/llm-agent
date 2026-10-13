#!/usr/bin/env node
// Evaluate cleanup-policy.json against the live `containers` repository and
// fail if any image that is running now would be deleted. Read-only.
//
//   node deploy/gcp/artifact-registry/check-cleanup.mjs \
//     [--policy FILE] [--kube-context CTX ...] [--show-deletes] [--no-beta-prune]
//
// It mirrors Artifact Registry's documented rules: a version is deleted when a
// Delete policy matches and no Keep policy does. The registry's own dry run
// (see README.md) is the ground truth; this gives the same answer up front.
// Unless --no-beta-prune is given, it first drops the tags that
// prune-beta-tags.mjs would remove, as that job runs before the policy does.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOST, PROJECT, betaTagsToRemove, listImages } from './registry.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const policyFile = opt('--policy') ?? fileURLToPath(new URL('./cleanup-policy.json', import.meta.url));
const kubeContexts = args.flatMap((a, i) => (a === '--kube-context' ? [args[i + 1]] : []));
const showDeletes = args.includes('--show-deletes');
const betaPrune = !args.includes('--no-beta-prune');

const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 256 << 20 });

const DUR = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
const ms = d => { const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(d); if (!m) throw new Error(`bad duration ${d}`); return m[1] * DUR[m[2]]; };

function matches(c, v, now) {
  const tagState = (c.tagState ?? 'any').toLowerCase();
  if (tagState === 'tagged' && !v.tags.length) return false;
  if (tagState === 'untagged' && v.tags.length) return false;
  if (c.tagPrefixes && !v.tags.some(t => c.tagPrefixes.some(p => t.startsWith(p)))) return false;
  if (c.packageNamePrefixes && !c.packageNamePrefixes.some(p => v.pkg.startsWith(p))) return false;
  if (c.versionNamePrefixes && !c.versionNamePrefixes.some(p => v.digest.startsWith(p))) return false;
  if (c.olderThan && now - v.created <= ms(c.olderThan)) return false;
  if (c.newerThan && now - v.created >= ms(c.newerThan)) return false;
  return true;
}

function evaluate(policies, images) {
  const now = Date.now();
  const byPkg = Map.groupBy(images, v => v.pkg);
  for (const vs of byPkg.values()) vs.sort((a, b) => b.created - a.created);
  for (const v of images) {
    v.keep = []; v.del = [];
    for (const p of policies) {
      const keep = p.action.type.toLowerCase() === 'keep';
      if (p.mostRecentVersions) {
        const { packageNamePrefixes: pre, keepCount } = p.mostRecentVersions;
        if ((!pre || pre.some(x => v.pkg.startsWith(x))) && byPkg.get(v.pkg).indexOf(v) < keepCount) v.keep.push(p.name);
      } else if (matches(p.condition, v, now)) {
        (keep ? v.keep : v.del).push(p.name);
      }
    }
    v.deleted = v.del.length > 0 && v.keep.length === 0;
  }
  return byPkg;
}

// Image references that something will pull: Cloud Run serving revisions,
// pod specs and running pod digests, and konlet VM declarations.
function inUse() {
  const refs = [];
  const services = JSON.parse(run('gcloud', ['run', 'services', 'list', `--project=${PROJECT}`, '--format=json']));
  for (const s of services) {
    const region = s.metadata.labels?.['cloud.googleapis.com/location'];
    for (const t of s.status.traffic ?? []) {
      if (!t.percent) continue;
      const digest = run('gcloud', ['run', 'revisions', 'describe', t.revisionName, `--region=${region}`,
        `--project=${PROJECT}`, '--format=value(status.imageDigest)']).trim();
      refs.push({ who: `cloudrun ${s.metadata.name}`, ref: digest, hard: true });
    }
  }
  for (const ctx of kubeContexts) {
    const pods = JSON.parse(run('kubectl', ['--context', ctx, 'get', 'pods', '-A', '-o', 'json'])).items;
    for (const p of pods) {
      const who = `k8s ${ctx.split('-')[1]} ${p.metadata.namespace}/${p.metadata.name}`;
      for (const c of [...(p.spec.containers ?? []), ...(p.spec.initContainers ?? [])]) refs.push({ who, ref: c.image, hard: true });
      // A pod pulls its spec ref again on restart, so a running digest that is gone is only a warning.
      for (const c of [...(p.status.containerStatuses ?? []), ...(p.status.initContainerStatuses ?? [])]) refs.push({ who, ref: c.imageID.replace(/^docker-pullable:\/\//, ''), hard: false });
    }
  }
  const vms = JSON.parse(run('gcloud', ['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=json']));
  for (const vm of vms) {
    const decl = vm.metadata?.items?.find(i => i.key === 'gce-container-declaration')?.value ?? '';
    for (const m of decl.matchAll(/image:\s*(?:>-\s*)?(\S+)/g)) refs.push({ who: `vm ${vm.name}`, ref: m[1], hard: true });
  }
  return refs.filter(r => r.ref.startsWith(HOST));
}

function resolve(ref, images) {
  const rest = ref.slice(HOST.length);
  if (rest.includes('@')) { const [pkg, digest] = rest.split('@'); return images.find(v => v.pkg === pkg && v.digest === digest); }
  const i = rest.lastIndexOf(':');
  const [pkg, tag] = i < 0 ? [rest, 'latest'] : [rest.slice(0, i), rest.slice(i + 1)];
  return images.find(v => v.pkg === pkg && v.origTags.includes(tag));
}

const policies = JSON.parse(readFileSync(policyFile, 'utf8'));
const listed = await listImages();
const images = listed.filter(v => !v.attachment);
console.log(`${listed.length - images.length} provenance attachments not shown: they go with their image.`);
for (const v of images) { v.origTags = v.tags; v.pruned = []; }
if (betaPrune) {
  const remove = betaTagsToRemove(images);
  for (const { v, tag } of remove) { v.pruned.push(tag); v.tags = v.tags.filter(t => t !== tag); }
  console.log(`prune-beta-tags would remove ${remove.length} beta tags first.`);
}
const byPkg = evaluate(policies, images);

const GB = b => (b / 1e9).toFixed(1).padStart(7);
console.log('package'.padEnd(34), ' keep#', ' keepGB', '  del#', '  delGB');
let goneN = 0;
for (const [pkg, vs] of [...byPkg].sort()) {
  const k = vs.filter(v => !v.deleted), d = vs.filter(v => v.deleted);
  const kb = k.reduce((s, v) => s + v.bytes, 0), db = d.reduce((s, v) => s + v.bytes, 0);
  goneN += d.length;
  console.log(pkg.padEnd(34), String(k.length).padStart(6), GB(kb), String(d.length).padStart(6), GB(db));
  if (showDeletes) for (const v of d) console.log('   -', new Date(v.created).toISOString().slice(0, 10), v.digest.slice(7, 19), v.origTags.join(',') || '(untagged)');
}
console.log(`${goneN} versions to delete. Sizes are summed per image, so shared layers count more than once.`);

let failed = false;
for (const r of inUse()) {
  const v = resolve(r.ref, images);
  if (!v) { if (r.hard) { failed = true; console.log(`MISSING  ${r.who}: ${r.ref} is not in the registry now`); } continue; }
  const tagGone = r.hard && v.pruned.some(t => r.ref.endsWith(`:${t}`));
  if (!v.deleted && !tagGone) continue;
  if (r.hard) failed = true;
  console.log(`${r.hard ? 'FAIL' : 'WARN'}     ${r.who}: ${v.pkg}@${v.digest.slice(7, 19)} [${v.origTags.join(',')}] would ${v.deleted ? 'be deleted' : 'lose the tag it is pulled by'}`);
}
console.log(failed ? 'Something in use would be deleted.' : 'Nothing in use would be deleted.');
process.exit(failed ? 1 : 0);
