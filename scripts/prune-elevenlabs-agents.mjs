/**
 * Delete the ElevenLabs agents the Pipecat worker created for configurations
 * nothing uses any more (docs/elevenlabs-agents.md), and the tools they own.
 *
 *   node scripts/prune-elevenlabs-agents.mjs                   # agents idle for 30 days, from ./.env
 *   node scripts/prune-elevenlabs-agents.mjs --days 7 --dry-run
 *   ELEVENLABS_AGENT_PREFIX=staging node scripts/prune-elevenlabs-agents.mjs
 *
 * An agent is idle when its last conversation (or, with none, its creation)
 * is older than --days. Only agents tagged `aplisay` whose name starts with
 * the prefix are considered. A tool still referenced by another agent is left
 * alone (ElevenLabs answers 409); a deleted agent still counts as a dependant
 * unless the delete is forced, so it is.
 */
import { loadEnv } from './env.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const dryRun = args.includes('--dry-run') || Boolean(process.env.DRY_RUN);
const days = Number(flag('--days') || 30);
const prefix = (process.env.ELEVENLABS_AGENT_PREFIX || 'aplisay').trim();
const base = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set');
  process.exit(1);
}

async function call(method, path, params) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { 'xi-api-key': key } });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function listAgents() {
  const agents = [];
  let cursor;
  do {
    const page = await call('GET', '/v1/convai/agents', { page_size: 100, search: prefix, cursor });
    agents.push(...(page.agents || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return agents.filter((a) => String(a.name || '').startsWith(`${prefix}:`) && (a.tags || []).includes('aplisay'));
}

const cutoff = Date.now() / 1000 - days * 86400;
const agents = await listAgents();
console.log(`${agents.length} agent${agents.length === 1 ? '' : 's'} named ${prefix}:*; pruning those idle for ${days} days${dryRun ? ' (dry run)' : ''}`);
let removed = 0;
for (const agent of agents) {
  const lastUsed = agent.last_call_time_unix_secs || agent.created_at_unix_secs || 0;
  if (lastUsed > cutoff) continue;
  const when = new Date(lastUsed * 1000).toISOString().slice(0, 10);
  if (dryRun) {
    console.log(`would delete ${agent.agent_id} (${agent.name}, last used ${when})`);
    continue;
  }
  const detail = await call('GET', `/v1/convai/agents/${agent.agent_id}`);
  const toolIds = detail?.conversation_config?.agent?.prompt?.tool_ids || [];
  await call('DELETE', `/v1/convai/agents/${agent.agent_id}`);
  let tools = 0;
  for (const toolId of toolIds) {
    try {
      await call('DELETE', `/v1/convai/tools/${toolId}`, { force: 'true' });
      tools += 1;
    } catch (e) {
      if (e.status !== 409) throw e;
    }
  }
  removed += 1;
  console.log(`deleted ${agent.agent_id} (${agent.name}, last used ${when}) and ${tools}/${toolIds.length} tools`);
}
console.log(`${removed} agent${removed === 1 ? '' : 's'} deleted`);
