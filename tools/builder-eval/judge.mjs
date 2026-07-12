/**
 * LLM judge: scores what the hard checks can't — prompt quality, faithfulness
 * to the brief, conversational efficiency — from the saved set + transcript.
 * Uses Claude Opus as the judge regardless of the candidate model under test,
 * so every candidate is marked by the same examiner.
 */
import { Anthropic as AnthropicSdk } from '@anthropic-ai/sdk';

const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'claude-opus-4-8';

const anthropic = new AnthropicSdk();

export async function judge({ scenario, result }) {
  const payload = {
    brief: scenario.turns.join('\n---\n'),
    rubric: scenario.rubric,
    finalSet: result.latestSet,
    transcript: result.transcript,
    hardCheckNotes: result.check?.notes ?? [],
  };
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    system:
      'You are grading an AI "agent builder" on one build session. Score STRICTLY against the '
      + 'rubric and the user\'s brief — not against what a bigger build could have been. '
      + 'Respond with ONLY a JSON object: {"promptQuality": 0-10, "faithfulness": 0-10, '
      + '"efficiency": 0-10, "overall": 0-10, "summary": "<one paragraph>"} — '
      + 'promptQuality = quality of the produced member prompts; faithfulness = did it build '
      + 'exactly what was asked, grounded only in given facts; efficiency = fewest turns/'
      + 'questions/detours to a correct result. No markdown, no prose outside the JSON.',
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    .replace(/```(json)?/g, ''); // some judgments arrive fenced despite the instruction
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    // The judge sometimes omits `overall` despite the instruction — derive it
    // from the subscores rather than losing the row's headline number.
    if (typeof parsed.overall !== 'number') {
      const subs = ['promptQuality', 'faithfulness', 'efficiency']
        .map((k) => parsed[k]).filter((v) => typeof v === 'number');
      if (subs.length) parsed.overall = Math.round((subs.reduce((a, b) => a + b, 0) / subs.length) * 10) / 10;
    }
    return { ...parsed, judgeModel: JUDGE_MODEL };
  } catch {
    return { promptQuality: null, faithfulness: null, efficiency: null, overall: null, summary: `unparseable judge output: ${text.slice(0, 200)}`, judgeModel: JUDGE_MODEL };
  }
}
