/**
 * Build/version identity, logged once at startup so a running service always
 * says exactly which code it is (catches stale deploys — e.g. a green build
 * that never rolled, or cluster pods that haven't re-pulled an image).
 *
 * Sources, in order:
 *  1. BUILD_COMMIT / BUILD_BRANCH / BUILD_TAG env — baked into the image by the
 *     Dockerfile from Cloud Build's COMMIT_SHA / BRANCH_NAME / TAG_NAME
 *     substitutions (see deploy/gcp/cloudrun/cloudbuild*.yaml).
 *  2. git (dev fallback — nodemon/local runs from a checkout).
 *  3. 'unknown'.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch {
    return null;
  }
}

/** { commit, branch, tag, source: 'env'|'git'|'unknown' } — fields null when unknown. */
export function buildInfo() {
  const env = {
    commit: process.env.BUILD_COMMIT?.trim() || null,
    branch: process.env.BUILD_BRANCH?.trim() || null,
    tag: process.env.BUILD_TAG?.trim() || null,
  };
  if (env.commit) return { ...env, source: 'env' };

  const commit = git('rev-parse --short=12 HEAD');
  if (commit) {
    return {
      commit,
      branch: git('rev-parse --abbrev-ref HEAD'),
      tag: git('describe --tags --exact-match'),
      source: 'git',
    };
  }
  return { commit: null, branch: null, tag: null, source: 'unknown' };
}

/** One-line human summary, e.g. "commit d01ed576eeb7 (branch next) [git]". */
export function describeBuild(info = buildInfo()) {
  if (!info.commit) return 'unknown (no BUILD_COMMIT baked and no git checkout)';
  return `commit ${info.commit}${info.tag ? ` tag ${info.tag}` : ''}${info.branch ? ` (branch ${info.branch})` : ''} [${info.source}]`;
}
