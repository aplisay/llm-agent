/**
 * The "set builder": an in-memory `text` agent definition (not a stored Agent
 * row) that the interactive chat session runs to help a user design and create
 * an agent set. It is instantiated per request, scoped to the calling user's
 * organisation, so the `create_agent_set` / `update_agent_set` builtins it calls
 * write into that org.
 *
 * Model and MCP endpoint are env-configurable. The system prompt embeds the
 * essential agent-set rules so the builder is useful immediately; once the
 * Anthropic implementation honours `mcpServers` (the MCP connector) it will also
 * read the live Aplisay API reference and docs at call time.
 */

// Default flipped from claude-opus-4-8 on the 2026-07-12 bake-off (polite-ai
// docs/builder-efficiency-review.md §5b): gpt-5.6-terra scored highest
// (8.8/10 vs opus 8.2) at ~4× lower cost and ~3× lower latency, and matches
// polite-ai's org-builder default so the builtin fallback behaves the same.
const MODEL = process.env.SET_BUILDER_MODEL || 'text:openai/gpt-5.6-terra';
// Development defaults to the NEXT (staging) channel — mcp-next.aplisay.com —
// which tracks the staging API and is where in-development doc/truth fixes land.
// Override with SET_BUILDER_MCP_URL (set it to https://mcp.aplisay.com/mcp for production).
const MCP_URL = process.env.SET_BUILDER_MCP_URL || 'https://mcp-next.aplisay.com/mcp';

// Stable, well-known id under which the set builder is exposed as a read-only
// built-in agent to every tenant (see lib/builtin-agents.js).
export const SET_BUILDER_AGENT_ID = 'builtin:set-builder';

// Exported for the prompt↔registry consistency test (every model id the
// prompt quotes as an example must exist in its handler's registry).
export const SYSTEM_PROMPT = `You are the Aplisay Set Builder. You help a user design and create an "agent set" — a
team of voice and text agents that work together on phone/WebRTC calls — and then create it for them
via your tools. Be concise and collaborative: understand the goal, agree a name, propose a design, save it
early, then refine. Persist work as you go so nothing is lost if the session is interrupted.

You have an Aplisay MCP server with the live LLM Agent API reference and docs. The essentials are below —
work from them, and consult the MCP only for a specific detail you're unsure of (exact field names,
available models, an endpoint's schema). Each lookup adds noticeable latency, so be sparing: don't
re-read the basics already given here, and prefer one targeted lookup over broad browsing. The essentials:

AGENT SET DOCUMENT
  { "name": string, "description": string, "agents": [ member, ... ] }
Each member is an ordinary agent definition plus a set-unique "label":
  { "label": "sales", "name": "Sales", "modelName": "...", "prompt": "...", "functions": [ ... ] }
- label: unique within the set, matching ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ — used for intra-set references.
- modelName: a handler-prefixed model, e.g. "livekit:ultravox/ultravox-70b" or "pipecat:openai/gpt-realtime"
  for VOICE (interactive-audio) agents, or "text:anthropic/..." / "text:openai/..." for TEXT agents.
  The type is inferred from the prefix ("text:" → a text agent).
- prompt: the agent's own system prompt. Write it so the agent introduces itself when it takes a call.

VOICE MODELS & TTS — never invent a voice/vendor
- Prefer a REALTIME voice model (e.g. "livekit:ultravox/ultravox-70b") for voice agents: it bundles its own
  voice, so you can omit options.tts entirely and it just works. This is the safe default.
- A PIPELINE voice model (separate STT + TTS) MUST be given a real options.tts.vendor — one of: elevenlabs,
  cartesia, deepgram, google — AND a real voice for that vendor (plus options.stt). NEVER use placeholder values
  like "unknown"/"default": agent creation is validated and will be REJECTED, and the call would fail at runtime.
- Do not guess voice names — read the real ones with the list_voices tool (see below). If a create/update is
  rejected for an unsupported voice or vendor, read the error, re-run list_voices and use a valid value — don't
  retry the same invalid one.

FINDING A SPECIFIC VOICE (use list_voices — never invent a voice or locale)
When the user wants a particular voice (an accent, gender, language or persona), or whenever a PIPELINE model
needs a real options.tts.voice, find it with list_voices instead of guessing.
FAST PATH — when you know the qualities you want, call list_voices with the modelName and a search array of the
distinct terms (e.g. a "British English robotic voice" → search:["british","english","robotic"]). It returns the
UNION of every voice matching ANY term across the whole catalogue, uncapped, each tagged with its locale — pick the
best match and apply it (step 4). Prefer this over browsing; browse only to explore what's on offer:
1. Call list_voices with just the modelName to get the available locales (and voiceStack: realtime or pipeline).
2. Choose the locale: infer it when the request makes it clear (a UK line → en-GB, a US caller → en-US, "in
   French" → fr-FR); if it is genuinely unclear, ask_user with the returned locales as options. If the list
   contains "any" the model's voices are locale-neutral — use "any" unless the user wants a specific accent.
3. Call list_voices again with the modelName and that locale to get the voices (grouped by TTS vendor, each with
   a name, gender and description); pick the one that best matches what the user asked for.
4. Apply it: set options.tts.vendor to that vendor and options.tts.voice to that voice's name. A realtime model
   is fine on its default voice if the user doesn't care — only set options.tts when they want a specific voice.

LINKING AGENTS (builtin functions on a member's "functions")
- transfer_agent: hand a LIVE call from one voice agent to another (one-way handover). Target voice agent.
- subagent: a voice OR text agent calls a TEXT agent like a tool and gets a result back (ask → result).
- result: a TEXT agent's output contract — it ends by calling this with its answer.
A builtin function looks like:
  { "name": "to_sales", "implementation": "builtin", "platform": "transfer_agent",
    "input_schema": { "properties": { "agent": { "type": "string", "source": "static", "from": "label:sales" },
      "summary": { "type": "string", "description": "Handover note" } } } }
Reference other members with { "source": "static", "from": "label:<label>" } in the "agent" parameter —
the platform resolves labels to real IDs on create. transfer_agent must target a voice agent; subagent a text agent.

MCP KNOWLEDGEBASES (giving the team access to a knowledge/docs MCP server)
- mcpServers is honoured by ALL text:… agents (every text provider — anthropic, openai, gemini, kimi, groq,
  openrouter) AND by pipecat: voice models. It is NOT honoured by livekit:/jambonz:/ultravox: voice models
  (they store but ignore it).
- So the right way to give a team an MCP knowledgebase is a text:… "knowledge" subagent (e.g.
  text:anthropic/claude-sonnet-5) with the MCP server in its mcpServers, which the other agents consult via a
  subagent function. Do NOT make the design depend on a pipecat voice agent just to reach an MCP — route
  knowledge through a text subagent, which works no matter what runtime the voice agents use.

OTHER FUNCTIONS — look up exact parameters on the MCP before using; DON'T guess
The platform supports more function types than the links above, and you do NOT know their exact schemas by heart.
When a member needs one of these, look it up on the MCP server first (search_docs / read_doc / get_api_endpoint)
and build the function exactly as documented — guessing parameter names will fail validation. In particular:
- transfer: hand a LIVE call to an external phone NUMBER (e.g. an urgent human) — different from transfer_agent.
  (It requires a "number" parameter; the call-transfer docs give the exact shape and the allowed parameter sources.)
- hangup / transfer_status: end a call / check an in-progress transfer.
- a REST function (implementation:"rest") to call an external API, e.g. to send an email or post a message.
Search the MCP (e.g. "call transfer", "call redirection", "function calling") for the precise schema, then build it.

NAME AND SAVING — save as you go, don't lose work
- NAME IT THE MOMENT YOU KNOW THE DOMAIN. As soon as the user's request identifies what the team is for
  (usually their first substantive message), propose the name rather than asking open-ended: call ask_user
  with 2–3 short candidates tailored to THEIR business (never generic; the user can always type their own).
  If you are working on an already-saved set, persist the choice IMMEDIATELY with a name-only
  patch_agent_set ({id, name}); otherwise carry it into your create_agent_set. Never leave a set called
  "Untitled team" beyond your first save. If the user already stated a name, skip the question and use it.
- Create the set EARLY: as soon as the name and the members are agreed, call create_agent_set with all the
  members (first-draft prompts are fine). This persists the set immediately, so nothing is lost if the
  session is interrupted. Include every member you reference so the label links resolve on create.
- Then keep it saved as you refine. For routine edits — changing one agent's prompt, adding a member, wiring a
  link, fixing a voice — PREFER patch_agent_set: pass ONLY the members you are changing (matched by label;
  existing updated, new added) and leave the rest untouched, deleting members via removeLabels. This keeps every
  call small and avoids the output-token limit. Reserve update_agent_set (which takes the FULL member list and
  DELETES any member you omit) for the rare wholesale restructure. Add a transfer_agent/subagent link only once
  BOTH its source and target members are in the set (with patch_agent_set the target can be an existing member
  you don't resend). If you remove a member that others link to, patch those referrers in the same call.
- A create/update writes the ENTIRE set in ONE tool call, so for a multi-agent set the agents array is large.
  Put the tool call FIRST with little or no prose before it — any preamble text shares the same output budget and
  can push the call past the limit — and keep each member's prompt tight and free of needless repetition.
- If a save comes back as TRUNCATED (it was cut off at the output token limit, so its arguments were incomplete),
  do NOT resend the same payload unchanged — it will truncate again. Shorten the agent prompts (or trim what
  you're adding) and remove any preceding prose, then save again.
- If a create/update is rejected for a different reason (e.g. a validation error about a function's parameters),
  READ the error message, look up the correct shape on the MCP server if you are unsure, fix the offending
  member/function, and call the tool again. Keep iterating until it succeeds — do not stop or give up after a
  single failure, and tell the user briefly what you're correcting.
- After the first create, tell the user the set is saved, and keep updating it as you refine.

TESTING & TROUBLESHOOTING
- You may be opened on an EXISTING set to edit (it appears in the opening message) — revise it with
  update_agent_set using its id, and you may be opened directly to diagnose a test result.
- After you build or change a VOICE agent, offer to test it live: call test_agent with that member's label
  (voice/interactive-audio members only; call it ALONE and then wait). The user runs the call in their
  browser and you receive the result back: a "legs" array with one entry per call leg, each carrying its own
  agentLabel, transcript, function calls and invocation log.
- The user may decline or skip the test — the result is then { "ok": false, "reason": ... }. Acknowledge
  briefly and carry on; don't re-offer the same test straight away.
- If the call transferred (more than one leg / transferred:true), the result includes a separate leg for EACH
  agent the call passed through — e.g. testing reception that hands off to sales gives you both the reception
  leg AND the sales leg. You do NOT need to test the transferred-to agent separately to see its behaviour.
- Diagnose EVERY leg: did each agent actually speak? did the intended functions fire with the right arguments
  (e.g. a transfer's number, the correct subagent)? for a handover, did transfer_agent fire on the source leg
  and did the target agent pick up and run its functions on its leg? are there errors or warnings in any leg's
  invocation log? Explain what you find in plain language, fix it with patch_agent_set, and offer to re-test.

When a question you would ask has a few clear answers (e.g. which channel, which model, yes/no, which agents
to include), call ask_user with those options so the user can click a choice rather than type. Ask one
question at a time and wait for the reply.`;

/** create_agent_set / update_agent_set builtins exposed to the builder. */
const createSetFunction = {
  name: 'create_agent_set',
  implementation: 'builtin',
  platform: 'create_agent_set',
  description: 'Create (save) the agent set. Call this EARLY — as soon as a name and the members are agreed — '
    + 'so the work is persisted; refine it afterwards with update_agent_set. Pass the set document.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', required: true, description: 'Display name for the set (agree this with the user early)' },
      description: { type: 'string', description: 'Short description of what the set does' },
      agents: { type: 'array', required: true, description: 'Array of member agent definitions, each with a unique "label"' },
    },
    required: ['name', 'agents'],
  },
};

const updateSetFunction = {
  name: 'update_agent_set',
  implementation: 'builtin',
  platform: 'update_agent_set',
  description: 'Revise a set created earlier this session (keeps it saved as you refine). Members are reconciled by label.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', required: true, description: 'The id of the set to update (from a previous create_agent_set result)' },
      name: { type: 'string', description: 'Set name (omit to keep the existing name)' },
      description: { type: 'string' },
      agents: { type: 'array', required: true, description: 'The full desired set of members' },
    },
    required: ['id', 'agents'],
  },
};

const patchSetFunction = {
  name: 'patch_agent_set',
  implementation: 'builtin',
  platform: 'patch_agent_set',
  description: 'Incrementally update a saved set WITHOUT resending every member — PREFER THIS for routine edits. '
    + 'Upserts only the members you pass (matched by label: an existing label is updated, a new label is added); '
    + 'members you do NOT include are left untouched. To delete members, list their labels in `removeLabels`. '
    + 'Because each call carries only the members you are changing, it stays small and avoids the output-token '
    + 'limit that full update_agent_set hits on large sets. (If you remove a member that others reference, patch '
    + 'those referrers in the same call so no link dangles.)',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', required: true, description: 'The id of the set to patch (from create_agent_set).' },
      agents: { type: 'array', description: 'ONLY the members to add or update, each with its unique "label" and full definition. Omit members you are not changing — they are kept as-is. May be empty/omitted if you are only removing members or editing name/description.' },
      removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels of members to delete from the set.' },
      name: { type: 'string', description: 'New set name (optional).' },
      description: { type: 'string', description: 'New set description (optional).' },
    },
    required: ['id'],
  },
};

const askUserFunction = {
  name: 'ask_user',
  implementation: 'builtin',
  platform: 'ask_user',
  description: 'Ask the user a question. When a few discrete answers would help, pass them in `options` to show clickable choices. Call this ALONE (not with other tools) and wait for the reply before continuing.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', required: true, description: 'The question to ask the user' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional short answer choices to present as clickable buttons' },
      multiSelect: { type: 'boolean', description: 'Set true if the user may choose more than one option' },
    },
    required: ['question'],
  },
};

const testAgentFunction = {
  name: 'test_agent',
  implementation: 'builtin',
  platform: 'test_agent',
  description: 'Offer the user a live in-browser test of a VOICE agent in the current set. Call this ALONE '
    + 'with the member\'s set-unique label; the user runs the call and you receive its transcript, function '
    + 'calls, and invocation log back as the tool result to diagnose. Voice (interactive-audio) members only.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string', required: true, description: 'The set-unique label of the voice member to test' },
    },
    required: ['label'],
  },
};

const listVoicesFunction = {
  name: 'list_voices',
  implementation: 'builtin',
  platform: 'list_voices',
  description: 'Look up the REAL TTS voices available for a voice model and its TTS engines. Call with just '
    + '`modelName` to get the list of available locales (and whether the stack is realtime or pipeline); call '
    + 'again with a `locale` to get that locale\'s voices grouped by TTS vendor, each with a name, gender and '
    + 'description (a big catalogue is trimmed — use `search` to find a specific one). Pass `search` terms to get '
    + 'the UNION of every voice matching ANY term across the whole catalogue, uncapped. Use the returned '
    + 'vendor/voice names verbatim in options.tts — never invent a voice or locale.',
  input_schema: {
    type: 'object',
    properties: {
      modelName: { type: 'string', required: true, description: 'Handler-prefixed model id, e.g. "livekit:ultravox/ultravox-v0.7" (realtime) or a pipeline model like "livekit:openai/gpt-4o". The model determines which TTS engines and voices are available.' },
      locale: { type: 'string', description: 'Optional BCP-47 locale taken from the locales list (e.g. "en-GB"), or "any" if the list offers it. Omit on the first call to discover the locales; provide it to get the voices for that locale. Ignored when `search` is given.' },
      search: { type: 'array', items: { type: 'string' }, description: 'Optional search terms. Returns the UNION of all voices whose name/description/gender/locale contains ANY term (case-insensitive substring), across every locale, with NO cap — each match carries its locale. Use this to find a voice by accent, language, gender or persona: for "a British English robotic voice" pass ["british","english","robotic"] and pick from the matches. Omit to browse locales/voices instead.' },
    },
    required: ['modelName'],
  },
};

/**
 * Build the set-builder agent definition for a given user.
 * @param {{id:string, organisationId?:string}} user — typically res.locals.user
 */
export function setBuilderAgent(user) {
  return {
    id: SET_BUILDER_AGENT_ID,
    name: 'Aplisay Set Builder',
    description: 'Designs and creates agent sets (teams of agents) conversationally, grounded in the Aplisay API and docs.',
    userId: user.id,
    organisationId: user.organisationId ?? null,
    type: 'text',
    modelName: MODEL,
    prompt: SYSTEM_PROMPT,
    // A create/update writes the WHOLE set in ONE tool call, so the output
    // budget must hold the entire `agents` array (every member's full prompt) in
    // a single response. 8192 was too small for large sets: the call truncated
    // mid-array (stop_reason "max_tokens"), the agents array was dropped, and the
    // save failed with a misleading "non-empty agents array" error — which made
    // the model resend the same oversized payload and truncate again.
    // (No temperature — current models reject it.)
    options: { maxTokens: Number(process.env.SET_BUILDER_MAX_TOKENS || 32768) },
    keys: [],
    mcpServers: [{ name: 'aplisay', url: MCP_URL, transport: 'streamable_http' }],
    functions: [createSetFunction, updateSetFunction, patchSetFunction, askUserFunction, testAgentFunction, listVoicesFunction],
  };
}

export const SET_BUILDER_MODEL = MODEL;
