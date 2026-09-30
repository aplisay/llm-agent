/**
 * @livekit/agents-plugin-openai 1.9.x with the socket connect replaced. The plugin's connecting
 * socket has no 'error' listener, so a failed connect was an uncaught exception that ended the job
 * process, and it connects outside its retry try/catch. Upstream adds only the listener:
 * livekit/agents-js#2539. agents-js emits no Close for an error inside AgentSession.start(), so
 * the caller's session also reports unrecoverable errors through provider-ended.ts, as Ultravox does.
 */
import * as openai from "@livekit/agents-plugin-openai";
import { WebSocket } from "ws";
import logger from "./logger.js";

type RealtimeOptions = openai.realtime.RealtimeModel["_options"];
type RealtimeErrorArgs = { error: Error; recoverable: boolean };
type ProviderEndedInfo = { reason?: string };

/** Session members the plugin's types mark private, and the base class's model getter. */
interface PluginSession {
  _options: RealtimeOptions;
  emitError(ev: RealtimeErrorArgs): void;
  readonly realtimeModel: unknown;
}

const pluginEmitError = (openai.realtime.RealtimeSession.prototype as unknown as PluginSession)
  .emitError;

/** The plugin's createWsConn (1.9.0), with an 'error' listener. */
function connectRealtimeSocket(options: RealtimeOptions): Promise<WebSocket> {
  const headers: Record<string, string> = { "User-Agent": "LiveKit-Agents-JS" };
  if (options.isAzure) {
    if (options.entraToken) {
      headers.Authorization = `Bearer ${options.entraToken}`;
    } else if (options.apiKey) {
      headers["api-key"] = options.apiKey;
    } else {
      return Promise.reject(new Error("Microsoft API key or entraToken is required"));
    }
  } else {
    if (!options.apiKey) {
      return Promise.reject(
        new Error("OpenAI API key is required but not set. Check OPENAI_API_KEY environment variable."),
      );
    }
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  const url = openai.realtime.processBaseURL({
    baseURL: options.baseURL,
    model: options.model,
    isAzure: options.isAzure,
    apiVersion: options.apiVersion,
    azureDeployment: options.azureDeployment,
  });

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error("OpenAI Realtime API connection timed out"));
      // On a connecting socket close() makes ws emit 'error', which fail() then ignores.
      ws.close();
    }, options.connOptions.timeoutMs);
    // Left attached after 'open': the plugin sets its own onerror only when runWs starts.
    ws.on("error", (e) =>
      fail(new Error(`OpenAI Realtime API connection failed: ${e.message}`, { cause: e })),
    );
    ws.once("close", () => fail(new Error("OpenAI Realtime API connection closed")));
    ws.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
  });
}

/**
 * Replaces the plugin's createWsConn, which its types mark private. The session constructor
 * makes the first call, so this has to be on the prototype, not patched onto an instance.
 */
async function createWsConn(this: PluginSession): Promise<WebSocket> {
  try {
    return await connectRealtimeSocket(this._options);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // The plugin does not retry a failed connect: the rejection ends its main task.
    this.emitError({ error, recoverable: false });
    throw error;
  }
}

/** In the plugin every unrecoverable error ends the session's main task: the call has lost its model. */
function emitError(this: PluginSession, ev: RealtimeErrorArgs): void {
  if (!ev.recoverable) {
    try {
      (this.realtimeModel as OpenAIRealtimeModel)._notifyProviderEnded(this, {
        reason: ev.error.message,
      });
    } catch (e) {
      logger.warn({ e }, "provider-ended notification failed");
    }
  }
  pluginEmitError.call(this, ev);
}

class GuardedRealtimeSession extends openai.realtime.RealtimeSession {}
Object.defineProperties(GuardedRealtimeSession.prototype, {
  createWsConn: { value: createWsConn },
  emitError: { value: emitError },
});

export class OpenAIRealtimeModel extends openai.realtime.RealtimeModel {
  #providerEndedCallback?: (info: ProviderEndedInfo) => void;
  // The caller's session. A consult session is made later from the same model, and the SDK
  // reuses this one across an in-place handover, so unlike Ultravox there is no mark to move.
  #primarySession?: openai.realtime.RealtimeSession;

  /** See provider-ended.ts. Only the caller's session reports. */
  setProviderEndedCallback(cb: (info: ProviderEndedInfo) => void): void {
    this.#providerEndedCallback = cb;
  }

  /** @internal Called by a session that reported an unrecoverable error. */
  _notifyProviderEnded(session: unknown, info: ProviderEndedInfo): void {
    if (session !== this.#primarySession) return;
    this.#providerEndedCallback?.(info);
  }

  session(): openai.realtime.RealtimeSession {
    const session = new GuardedRealtimeSession(this);
    this.#primarySession ??= session;
    return session;
  }

  /** What a log line gets if the model is ever logged whole: never its options. */
  toJSON(): { label: string; model: string; provider: string } {
    return { label: this.label(), model: this.model, provider: this.provider };
  }
}
