/**
 * Builder-eval scenarios: scripted briefs a user might bring to the set
 * builder, each with hard checks against the saved artefacts and a judge
 * rubric for the qualities hard checks can't measure.
 *
 * Shape:
 *  - turns: user inputs sent in order, one per completed builder turn.
 *  - qa: [{ match, reply }] — answers for ask_user questions (first match
 *    wins); unmatched questions get DEFAULT_ANSWER so no run wedges.
 *  - seed: optional { set, testResult } opening seeds (edit / troubleshoot).
 *  - check({ set, frames, transcript }): hard, deterministic pass/fail
 *    assertions — set is the FINAL saved set doc (null when never saved).
 *  - rubric: what the judge should reward for this scenario.
 */

export const DEFAULT_ANSWER =
  "You choose — pick whatever is most sensible for a small business and carry on.";

const assert = (notes, cond, label) => {
  notes.push(`${cond ? "PASS" : "FAIL"}: ${label}`);
  return !!cond;
};

const memberFns = (m) => (Array.isArray(m?.functions) ? m.functions : []);
const findPlatform = (m, platform) => memberFns(m).find((f) => f?.platform === platform);
const isVoice = (m) => (m?.type || "interactive-audio") !== "text" && !String(m?.modelName || "").startsWith("text:");

/**
 * A link target is valid when it's a static reference to a sibling member —
 * either the `label:<x>` form the builder writes, or the resolved member id
 * the platform renders it as after save.
 */
const staticTargetsMember = (fn, set, label) => {
  const target = fn?.input_schema?.properties?.agent;
  if (target?.source !== "static") return false;
  const from = String(target?.from || "");
  if (label) {
    const member = (set?.agents || []).find((m) => m.label === label);
    return from === `label:${label}` || (member?.id && from === String(member.id));
  }
  const ids = new Set((set?.agents || []).map((m) => String(m.id)));
  return /^label:/.test(from) || ids.has(from);
};

export const scenarios = [
  {
    id: "faq-single",
    brief: "Single-agent FAQ voice line",
    turns: [
      "Build me a phone agent for my bakery, Crusty's of Leeds. It should answer common questions: opening hours (8am-4pm Tue-Sun), where we are (14 Bridge End, Leeds), and whether we take custom cake orders (yes, with 1 week notice). Keep it to one agent, call the team \"Bakery FAQ\".",
      "That's great — make sure it politely says it can't help with anything else and suggests calling back during opening hours for complex questions.",
    ],
    qa: [
      { match: /name|call (the|this)/i, reply: "Bakery FAQ" },
      { match: /model|voice|channel/i, reply: DEFAULT_ANSWER },
    ],
    check({ set }) {
      const notes = [];
      let ok = assert(notes, !!set?.id, "set was saved");
      ok = assert(notes, (set?.agents || []).length === 1, "exactly one member") && ok;
      const m = set?.agents?.[0];
      ok = assert(notes, isVoice(m), "member is a voice agent") && ok;
      const p = String(m?.prompt || "");
      ok = assert(notes, /8\s*am|8:00/i.test(p) && /leeds/i.test(p), "prompt carries the real hours and location") && ok;
      return { ok, notes };
    },
    rubric:
      "Reward: a warm, complete FAQ prompt grounded ONLY in the facts given (hours, address, cake orders with 1 week notice); an explicit scope limit with the call-back suggestion; sensible model/voice defaults; no invented facts (no made-up phone numbers, prices or services). Penalise: bloated prompts, unasked-for extra agents or functions.",
  },
  {
    id: "receptionist-transfer",
    brief: "Reception + sales, live transfer",
    turns: [
      "I want a phone team for Gadget Traders: a receptionist that answers, finds out what the caller wants, and hands over to a sales agent for anything about buying our refurbished laptops. Call it \"Gadget Traders front desk\".",
      "Yes, build it and save it.",
    ],
    qa: [{ match: /.*/i, reply: DEFAULT_ANSWER }],
    check({ set }) {
      const notes = [];
      let ok = assert(notes, !!set?.id, "set was saved");
      const members = set?.agents || [];
      ok = assert(notes, members.length === 2, "two members") && ok;
      const withTransfer = members.find((m) => findPlatform(m, "transfer_agent"));
      ok = assert(notes, !!withTransfer, "a member carries a transfer_agent link") && ok;
      ok = assert(
        notes,
        staticTargetsMember(findPlatform(withTransfer || {}, "transfer_agent"), set),
        "transfer target is a static member reference (never model-generated)",
      ) && ok;
      ok = assert(notes, members.every(isVoice), "both members are voice agents (transfer needs voice→voice)") && ok;
      return { ok, notes };
    },
    rubric:
      "Reward: a receptionist prompt that triages before transferring, a sales prompt that continues naturally after handover, correct one-way transfer wiring, concise prompts. Penalise: transfer target left model-generated, sales agent that re-asks everything the receptionist learned (no handover summary), unnecessary members.",
  },
  {
    id: "booking-subagent",
    brief: "Voice booker + text availability subagent",
    turns: [
      "Build a booking line for Salon Aura. A voice agent takes appointment requests, and I want the availability logic in a separate text agent it can call like a tool — the text agent should just reason over these rules: open Mon-Sat 9-6, each appointment is 45 minutes, no double bookings before noon on Saturdays. Call the team \"Salon Aura bookings\".",
      "Save it as-is, that's everything.",
    ],
    qa: [{ match: /.*/i, reply: DEFAULT_ANSWER }],
    check({ set }) {
      const notes = [];
      let ok = assert(notes, !!set?.id, "set was saved");
      const members = set?.agents || [];
      const text = members.find((m) => !isVoice(m));
      const voice = members.find(isVoice);
      ok = assert(notes, !!text && !!voice, "one voice member and one text member") && ok;
      ok = assert(notes, !!findPlatform(voice || {}, "subagent"), "voice member calls the text member via subagent") && ok;
      ok = assert(notes, !!findPlatform(text || {}, "result"), "text member has the result output contract") && ok;
      const sub = findPlatform(voice || {}, "subagent")?.input_schema?.properties?.agent;
      ok = assert(notes, sub?.source === "static", "subagent target is static") && ok;
      return { ok, notes };
    },
    rubric:
      "Reward: clean separation (voice UX vs availability reasoning), the salon's actual rules encoded in the TEXT agent's prompt, the voice agent covering subagent latency conversationally, correct result contract. Penalise: rules duplicated or placed on the wrong member, missing latency handling, invented booking systems/integrations.",
  },
  {
    id: "voice-locale",
    brief: "Specific voice: UK female on a pipeline model",
    turns: [
      "One voice agent for Harrogate Wines: a friendly UK-accented female voice, and I specifically want a pipeline model (separate speech pieces), not a realtime one. It just takes messages for the owner. Name the team \"Harrogate Wines line\".",
      "Perfect, save it.",
    ],
    qa: [
      { match: /locale|accent|language/i, reply: "en-GB please" },
      { match: /.*/i, reply: DEFAULT_ANSWER },
    ],
    check({ set, frames }) {
      const notes = [];
      let ok = assert(notes, !!set?.id, "set was saved");
      const m = (set?.agents || [])[0];
      const listVoicesCalls = frames.filter(
        (f) => f.type === "tool_call" && (f.calls || []).some((c) => c.name === "list_voices"),
      );
      ok = assert(notes, listVoicesCalls.length >= 1, "list_voices was consulted (never invent a voice)") && ok;
      ok = assert(notes, !!m?.options?.tts?.vendor && !!m?.options?.tts?.voice, "options.tts carries a real vendor + voice") && ok;
      ok = assert(
        notes,
        !/unknown|default|placeholder/i.test(String(m?.options?.tts?.voice || "")),
        "voice is not a placeholder value",
      ) && ok;
      return { ok, notes };
    },
    rubric:
      "Reward: correct pipeline (not realtime) model choice; a voice actually drawn from list_voices output matching UK/female; options.stt handled as the platform requires; a tight message-taking prompt. Penalise: realtime model despite the explicit ask, invented voice names, skipping the locale step.",
  },
  {
    id: "edit-existing",
    brief: "Edit a seeded set with patch discipline",
    seed: {
      set: {
        name: "Clinic front desk",
        description: "Reception for a physio clinic",
        agents: [
          {
            label: "reception",
            name: "Reception",
            modelName: "livekit:ultravox/ultravox-70b",
            prompt:
              "You are the receptionist for Motion Physio. Greet callers, answer questions about opening hours (Mon-Fri 8-6) and prices (£55 initial, £45 follow-up), and take a message with the caller's name and number if they want a callback.",
            functions: [],
          },
        ],
      },
    },
    turns: [
      "Two changes: tighten the greeting so it's one short warm sentence, and add a second voice agent 'triage' that reception can transfer to when a caller describes an injury — triage should ask about the injury and recommend booking an initial assessment.",
      "Yes apply both changes.",
    ],
    qa: [{ match: /.*/i, reply: DEFAULT_ANSWER }],
    check({ set, frames }) {
      const notes = [];
      let ok = assert(notes, (set?.agents || []).length === 2, "triage member added (2 members)");
      const patchUsed = frames.some(
        (f) => f.type === "tool_call" && (f.calls || []).some((c) => c.name === "patch_agent_set"),
      );
      ok = assert(notes, patchUsed, "patch_agent_set used for the routine edit (not a wholesale update)") && ok;
      const reception = (set?.agents || []).find((m) => m.label === "reception");
      ok = assert(notes, !!findPlatform(reception || {}, "transfer_agent"), "reception gained the transfer to triage") && ok;
      ok = assert(notes, /£55|£45/.test(String(reception?.prompt || "")), "unrelated prompt content (prices) survived the edit") && ok;
      return { ok, notes };
    },
    rubric:
      "Reward: minimal, surgical edits (greeting genuinely tightened, everything else preserved), a triage prompt that does what was asked and no more, correct transfer wiring, patch (not update) for the change. Penalise: rewriting the whole reception prompt, dropping the prices/hours, wholesale update_agent_set for a two-line change.",
  },
  {
    id: "troubleshoot",
    brief: "Diagnose a failed transfer from a test-call bundle",
    // The fault: the reception PROMPT promises a transfer, but the member has
    // no transfer_agent function at all — a saveable, realistic builder miss
    // (an unsaveable fault like a broken label reference could never have
    // become a stored set in the first place).
    seed: {
      set: {
        name: "Gadget Traders front desk",
        description: "Reception + sales",
        agents: [
          {
            label: "reception",
            name: "Reception",
            modelName: "livekit:ultravox/ultravox-70b",
            prompt:
              "You are the Gadget Traders receptionist. Find out what the caller wants; for anything about buying laptops, use your to_sales function to transfer the call to the sales agent with a short summary.",
            functions: [],
          },
          {
            label: "sales",
            name: "Sales",
            modelName: "livekit:ultravox/ultravox-70b",
            prompt: "You are the Gadget Traders sales agent. Help callers buy refurbished laptops.",
            functions: [],
          },
        ],
      },
      testResult: {
        ok: true,
        transferred: false,
        legCount: 1,
        legs: [
          {
            callId: "eval-call-1",
            agentLabel: "reception",
            agentName: "Reception",
            transcript: [
              { role: "agent", text: "Thanks for calling Gadget Traders, how can I help?" },
              { role: "user", text: "I want to buy one of your refurbished ThinkPads." },
              { role: "agent", text: "Let me put you through to sales." },
              { role: "hangup", text: "call ended without a transfer" },
            ],
            functions: [
              {
                type: "function_calls",
                data: [{ name: "to_sales", input: { summary: "wants a refurbished ThinkPad" } }],
              },
              {
                type: "function_results",
                data: [{ name: "to_sales", result: "ERROR: no such function 'to_sales' is defined on this agent" }],
              },
            ],
            invocationLog: {
              total: 3,
              notable: 1,
              entries: [{ level: 50, msg: "model attempted call to undefined function 'to_sales'" }],
            },
          },
        ],
      },
    },
    turns: [
      "Yes please fix whatever went wrong with that call.",
    ],
    qa: [{ match: /.*/i, reply: "Yes, apply the fix." }],
    check({ set, transcript }) {
      const notes = [];
      const saidWhy = transcript.some(
        (m) => m.role === "agent" && /to_sales|function|tool|missing|undefined|not (defined|wired|configured)/i.test(m.text),
      );
      let ok = assert(notes, saidWhy, "diagnosis names the missing transfer function");
      const reception = (set?.agents || []).find((m) => m.label === "reception");
      ok = assert(
        notes,
        staticTargetsMember(findPlatform(reception || {}, "transfer_agent"), set, "sales"),
        "reception gained a transfer_agent targeting the sales member",
      ) && ok;
      return { ok, notes };
    },
    rubric:
      "Reward: reading the invocation log, pinpointing that the prompt references a to_sales function that was never defined on the member, a one-line patch that adds exactly that transfer link, offering a re-test. Penalise: guessing at prompt changes, rebuilding members, missing the log evidence, verbose non-diagnosis.",
  },
];
