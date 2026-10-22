/**
 * The ElevenLabs Agents REST surface the worker uses: find or create the hosted
 * agent for a configuration, and mint the signed URL a conversation joins with.
 * The Python twin is agents/pipecat/pipecat_aplisay/elevenlabs_agents_client.py;
 * see docs/elevenlabs-agents.md.
 *
 * The hosted agent is found by name, which carries the configuration digest, so
 * every worker process converges on the same agent with no shared state of the
 * platform's own. Creation takes about three seconds, a lookup about 200 ms,
 * and a process remembers what it has found.
 */
import { agentName, apiBase, configHash, createBody } from "./elevenlabs-agents.js";
import logger from "./logger.js";

/** Fits a create (about 3 s) with margin. */
export const REQUEST_TIMEOUT_MS = 20_000;

type Dict = Record<string, unknown>;
type FetchLike = typeof fetch;

export class ElevenLabsAgentsError extends Error {
  status?: number;
  body: string;
  constructor(what: string, status?: number, body = "") {
    super(`ElevenLabs ${what} failed${status !== undefined ? ` (${status})` : ""}: ${body.slice(0, 300)}`);
    this.name = "ElevenLabsAgentsError";
    this.status = status;
    this.body = body;
  }
}

// name -> agent_id, shared by every session in the process.
const knownAgents = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/** Drop the process cache (tests, and a 404 on a cached id). */
export function forgetKnownAgents(): void {
  knownAgents.clear();
}

export class ElevenLabsAgentsClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(apiKey: string, { baseUrl, fetchImpl }: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    this.#apiKey = apiKey;
    this.#baseUrl = (baseUrl || apiBase()).replace(/\/+$/, "");
    this.#fetch = fetchImpl || fetch;
  }

  async #request(method: string, path: string, what: string, { params, json }: { params?: Record<string, string>; json?: unknown } = {}): Promise<Dict> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: { "xi-api-key": this.#apiKey, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ElevenLabsAgentsError(what, undefined, e instanceof Error ? e.message : String(e));
    }
    const text = await response.text();
    if (!response.ok) throw new ElevenLabsAgentsError(what, response.status, text);
    if (!text) return {};
    try {
      const body = JSON.parse(text);
      return body && typeof body === "object" ? (body as Dict) : {};
    } catch {
      return {};
    }
  }

  /** The id of the agent named exactly `name`, or undefined. */
  async findAgent(name: string): Promise<string | undefined> {
    const body = await this.#request("GET", "/v1/convai/agents", "agent lookup", { params: { search: name, page_size: "100" } });
    const agents = Array.isArray(body.agents) ? (body.agents as Dict[]) : [];
    const hit = agents.find((a) => a.name === name && typeof a.agent_id === "string");
    return hit ? String(hit.agent_id) : undefined;
  }

  async createAgent(body: Dict): Promise<string> {
    const created = await this.#request("POST", "/v1/convai/agents/create", "agent create", { json: body });
    if (typeof created.agent_id !== "string" || !created.agent_id) throw new ElevenLabsAgentsError("agent create", undefined, JSON.stringify(created));
    return created.agent_id;
  }

  /** The hosted agent for `config`: remembered, found by name, or created. */
  async ensureAgent(config: Dict): Promise<string> {
    const name = agentName(configHash(config));
    const cached = knownAgents.get(name);
    if (cached) return cached;
    const inflight = pending.get(name);
    if (inflight) return inflight;
    const task = (async () => {
      let agentId = await this.findAgent(name);
      if (agentId) {
        logger.info({ name, agentId }, "ElevenLabs agent found");
      } else {
        agentId = await this.createAgent(createBody(config, name));
        logger.info({ name, agentId }, "ElevenLabs agent created");
      }
      knownAgents.set(name, agentId);
      return agentId;
    })().finally(() => pending.delete(name));
    pending.set(name, task);
    return task;
  }

  async signedUrl(agentId: string): Promise<string> {
    const body = await this.#request("GET", "/v1/convai/conversation/get-signed-url", "signed url", { params: { agent_id: agentId } });
    if (typeof body.signed_url !== "string" || !body.signed_url) throw new ElevenLabsAgentsError("signed url", undefined, JSON.stringify(body));
    return body.signed_url;
  }

  /** The agent id and signed URL for a conversation on `config`; a deleted agent is recreated once. */
  async conversationUrl(config: Dict): Promise<{ agentId: string; url: string }> {
    let agentId = await this.ensureAgent(config);
    try {
      return { agentId, url: await this.signedUrl(agentId) };
    } catch (e) {
      if (!(e instanceof ElevenLabsAgentsError) || (e.status !== 400 && e.status !== 404)) throw e;
      logger.warn({ agentId, status: e.status }, "ElevenLabs agent gone; recreating");
      knownAgents.delete(agentName(configHash(config)));
      agentId = await this.ensureAgent(config);
      return { agentId, url: await this.signedUrl(agentId) };
    }
  }

  async listAgents(search?: string): Promise<Dict[]> {
    const agents: Dict[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = { page_size: "100" };
      if (search) params.search = search;
      if (cursor) params.cursor = cursor;
      const body = await this.#request("GET", "/v1/convai/agents", "agent list", { params });
      agents.push(...((body.agents as Dict[]) || []));
      cursor = body.has_more && typeof body.next_cursor === "string" ? body.next_cursor : undefined;
    } while (cursor);
    return agents;
  }

  async getAgent(agentId: string): Promise<Dict> {
    return this.#request("GET", `/v1/convai/agents/${agentId}`, "agent get");
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.#request("DELETE", `/v1/convai/agents/${agentId}`, "agent delete");
    for (const [name, id] of knownAgents) if (id === agentId) knownAgents.delete(name);
  }

  /** Forced: a deleted agent still counts as a dependant otherwise. False when a live agent still uses it. */
  async deleteTool(toolId: string): Promise<boolean> {
    try {
      await this.#request("DELETE", `/v1/convai/tools/${toolId}`, "tool delete", { params: { force: "true" } });
      return true;
    } catch (e) {
      if (e instanceof ElevenLabsAgentsError && e.status === 409) return false;
      throw e;
    }
  }
}
