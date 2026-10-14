// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** When the caller's turn behind one emitted user transcript started and ended, in ms since epoch. */
export interface UserTurnTiming {
  startMs: number;
  endMs: number;
}

/** A final user transcript this session emitted, keyed by the item id the SDK gives its ChatMessage. */
export interface EmittedUserTurn {
  itemId: string;
  text: string;
}

/** The parts of a `GET /api/calls/{id}/messages` result this reads. */
export interface UltravoxCallMessage {
  role?: string;
  text?: string;
  wallClockTimespan?: { start?: string; end?: string };
}

const normalise = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Ultravox durations are decimal seconds with an `s` suffix, e.g. "12.072942s". */
const seconds = (value: string | undefined): number | undefined => {
  if (typeof value !== "string" || !value.endsWith("s")) return undefined;
  const n = Number(value.slice(0, -1));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Pair each emitted user transcript with Ultravox's record of that caller
 * message, in order and by text. The WebSocket `ordinal` is not used: its
 * offset from the messages' index differs between calls (0 or 1 measured).
 * `wallClockTimespan` is measured from the call's `joined` time.
 */
export function matchUserTurnTimings(
  turns: EmittedUserTurn[],
  messages: UltravoxCallMessage[],
  joinedMs: number,
): Map<string, UserTurnTiming> {
  const users = messages.filter((m) => m.role === "MESSAGE_ROLE_USER" && typeof m.text === "string");
  const timings = new Map<string, UserTurnTiming>();
  let next = 0;
  for (const turn of turns) {
    const want = normalise(turn.text);
    if (!want) continue;
    for (let i = next; i < users.length; i++) {
      if (normalise(users[i].text!) !== want) continue;
      next = i + 1;
      const start = seconds(users[i].wallClockTimespan?.start);
      const end = seconds(users[i].wallClockTimespan?.end);
      if (start !== undefined && end !== undefined) {
        timings.set(turn.itemId, {
          startMs: joinedMs + Math.round(start * 1000),
          endMs: joinedMs + Math.round(end * 1000),
        });
      }
      break;
    }
  }
  return timings;
}
