/**
 * Type declarations for the shared fallback-message cache, consumed by the
 * LiveKit agent through the `agent-lib/` symlink. The implementation is plain
 * JS (see `index.js`); this file exists so the TypeScript side gets real types
 * instead of `any`. Keep it in step with the JSDoc on the modules themselves.
 */

export const KEY_LENGTH: number;
export const DEFAULT_TIMEOUT_MS: number;

export interface ResolvedFallbackMessage {
  text: string;
  vendor?: string;
  voice?: string;
  language?: string;
}

export interface GcsPath {
  bucket: string;
  prefix: string;
}

export interface CacheLogger {
  debug?: (meta: unknown, message: string) => void;
  info?: (meta: unknown, message: string) => void;
  warn?: (meta: unknown, message: string) => void;
}

export function resolveFallbackMessage(
  message: unknown,
  agentOptions?: { tts?: { vendor?: string; voice?: string; language?: string } },
  opts?: {
    /**
     * Whether the agent's `options.tts` describes a real TTS whose vendor/voice
     * may be inherited. False for realtime speech-to-speech agents, whose
     * `options.tts` names a timbre of the model. Defaults to true.
     */
    inheritAgentTts?: boolean;
  },
): ResolvedFallbackMessage | null;

export function fallbackMessageKey(resolved: ResolvedFallbackMessage): string;

export function parseGcsPath(baseUrl: string): GcsPath;
export function defaultFallbackMessageBaseUrl(): string;
export function objectNameForKey(prefix: string, key: string): string;

export function encodeWav(pcm: Buffer, sampleRate: number): Buffer;
export function decodeWav(buffer: Buffer): { pcm: Buffer; sampleRate: number };

export function fetchCachedMessage(options: {
  key: string;
  baseUrl?: string;
  timeoutMs?: number;
  logger?: CacheLogger;
}): Promise<Buffer | null>;

export function storeCachedMessage(options: {
  key: string;
  wav: Buffer;
  baseUrl?: string;
  timeoutMs?: number;
  logger?: CacheLogger;
}): Promise<boolean>;
