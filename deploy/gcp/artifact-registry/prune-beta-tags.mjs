#!/usr/bin/env node
// Remove beta-x.y.z tags from old betas so the cleanup policy can delete them.
// Each package keeps its 3 newest betas or every beta from the last 14 days,
// whichever is more. It only removes tags; the repository's cleanup policy
// does the deleting, about a day later.
//
//   node deploy/gcp/artifact-registry/prune-beta-tags.mjs [--apply]
//
// Without --apply it only prints what it would remove.

import { api, betaTagsToRemove, listImages } from './registry.mjs';

const apply = process.argv.includes('--apply');
// Attachments carry no tags, so the prune does not need to know which they are.
const remove = betaTagsToRemove(await listImages({ attachments: false }));

for (const { v, tag } of remove) {
  // Full digest, so a tag can be put back before the policy deletes the version.
  console.log(`${apply ? 'untag' : 'would untag'} ${v.pkg}:${tag} ${v.pkg}@${v.digest} built ${new Date(v.created).toISOString().slice(0, 10)}`);
  if (apply) await api(`/packages/${encodeURIComponent(v.pkg)}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
}
console.log(`${remove.length} beta tags ${apply ? 'removed' : 'to remove'}.`);
