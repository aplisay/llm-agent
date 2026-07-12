/**
 * Drives one in-process builder chat session against a scenario: a fake
 * websocket pair feeds scripted user turns into lib/text-chat.js — the exact
 * production chat loop (LLM driver, tool dispatch, MCP connector, usage
 * metering) with no HTTP or auth in the way.
 */
import { createChatSession } from '../../lib/text-chat.js';
import { DEFAULT_ANSWER } from './scenarios.mjs';

const TURN_TIMEOUT_MS = Number(process.env.EVAL_TURN_TIMEOUT_MS || 240_000);
const MAX_QUESTIONS = 12; // runaway ask_user loops fail the run rather than hang it

/** Minimal ws double the session binds to; the driver is the "browser". */
function fakeWs() {
  const ws = {
    OPEN: 1,
    readyState: 1,
    handlers: {},
    onFrame: null,
    send(raw) {
      const frame = JSON.parse(raw);
      ws.onFrame?.(frame);
    },
    on(ev, fn) {
      ws.handlers[ev] = fn;
    },
    close() {
      ws.readyState = 3;
      ws.handlers.close?.();
    },
  };
  return ws;
}

/**
 * Run one scenario against one model. Returns everything the reporter and
 * judge need: the final saved set, all frames, the visible transcript,
 * per-turn latencies and any errors.
 */
export async function runScenario({ scenario, agent, logger }) {
  const session = createChatSession({
    agent,
    set: scenario.seed?.set,
    testResult: scenario.seed?.testResult,
    logger,
  });

  const frames = [];
  const transcript = [];
  const turnLatencies = [];
  const errors = [];
  let latestSet = null;
  let questionCount = 0;
  let turnIndex = 0;
  let turnStartedAt = Date.now();

  const ws = fakeWs();
  const sendToSession = (msg) => ws.handlers.message?.(JSON.stringify(msg));

  const done = new Promise((resolve, reject) => {
    let timer;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms (turn ${turnIndex})`)),
        TURN_TIMEOUT_MS,
      );
    };
    armTimeout();

    ws.onFrame = (frame) => {
      frames.push(frame);
      switch (frame.type) {
        case 'agent':
          transcript.push({ role: 'agent', text: frame.text });
          break;
        case 'user_echo':
          transcript.push({ role: 'user', text: frame.text });
          break;
        case 'set':
          latestSet = frame.set;
          break;
        case 'error':
          errors.push(frame.message);
          break;
        case 'question': {
          questionCount += 1;
          if (questionCount > MAX_QUESTIONS) {
            reject(new Error('runaway ask_user loop'));
            return;
          }
          const qa = (scenario.qa || []).find((q) => q.match.test(frame.question || ''));
          armTimeout();
          // Answer on the next tick — never re-enter the session mid-frame.
          setTimeout(() => sendToSession({ type: 'user', text: qa?.reply || DEFAULT_ANSWER }), 0);
          break;
        }
        case 'test':
          // The harness never runs a live call — decline so the turn resumes.
          armTimeout();
          setTimeout(
            () =>
              sendToSession({
                type: 'test_result',
                id: frame.id,
                result: JSON.stringify({ ok: false, reason: 'The user skipped the test.' }),
              }),
            0,
          );
          break;
        case 'turn_complete': {
          turnLatencies.push(Date.now() - turnStartedAt);
          // A pending question/test resumes the SAME logical exchange — its
          // handlers above continue the flow; only advance the script when
          // nothing is pending.
          if (session.pending) return;
          const next = scenario.turns[turnIndex];
          if (next === undefined) {
            clearTimeout(timer);
            resolve();
            return;
          }
          turnIndex += 1;
          turnStartedAt = Date.now();
          armTimeout();
          setTimeout(() => sendToSession({ type: 'user', text: next }), 0);
          break;
        }
        default:
          break;
      }
    };
  });

  const startedAt = Date.now();
  await session.handleChat(ws);
  try {
    await done;
  } finally {
    ws.close();
    // Don't wait out the re-attach grace in a harness run.
    session.teardown();
  }

  return {
    sessionId: session.id,
    latestSet,
    frames,
    transcript,
    turnLatencies,
    errors,
    wallMs: Date.now() - startedAt,
  };
}
