import { voice } from "@livekit/agents";
import defaultLogger from "./logger.js";
import { saveUsage as defaultSaveUsage } from "./api-client.js";
import type { UsageRecordPayload } from "./api-client.js";
import type { UsageVendors } from "./usage-vendors.js";
import type { VoiceMode } from "./voice-mode.js";

interface MeterEntry {
  technology: string;
  provider?: string;
  detail?: string;
  units: Record<string, number>;
}

interface MeterCall {
  id?: string;
  organisationId?: string;
  userId?: string;
  agentId?: string;
}

export interface UsageMeter {
  /** Attach metrics + final-transcript listeners to a voice session. */
  wire: (s: voice.AgentSession) => void;
  /** Flush accumulated meters to the ledger for the resolved call (mode 'set'). */
  flush: (finalised: boolean) => Promise<void>;
}

export interface MakeUsageMeterOptions {
  /** The call to attribute usage to, resolved lazily at flush time. */
  getCall: () => MeterCall | null | undefined;
  /** Canonical {vendor, detail} per technology (see resolveUsageVendors). */
  usageVendors: UsageVendors;
  /**
   * Realtime vs pipeline. Realtime (speech-to-speech) models bundle STT+TTS into
   * the model charge, so this meter must suppress separate stt/tts component rows
   * for them (the UserInputTranscribed listener fires for realtime agents too).
   * Defaults to pipeline behaviour (emit) when unset.
   */
  voiceMode?: VoiceMode;
  /** Fallback detail when neither the configured vendor nor the SDK label is known. */
  fallbackDetail?: string;
  /** Skip events from a session that is no longer the active one. */
  isStale?: (s: voice.AgentSession) => boolean;
  log?: typeof defaultLogger;
  /** Injectable for tests; defaults to the api-client saveUsage. */
  saveUsageFn?: (records: unknown[]) => Promise<unknown>;
}

/**
 * A reusable per-call usage meter: accumulate llm/tts/stt metrics from a voice
 * session and flush them to the ledger attributed to `getCall()`. This mirrors
 * the main metering closure in voice-agent-runtime.ts and is used for the
 * consult-leg session so its usage lands on the *consult* call record rather than
 * the primary call — and, being per-session, never double-counts the primary.
 */
export function makeUsageMeter(opts: MakeUsageMeterOptions): UsageMeter {
  const {
    getCall,
    usageVendors,
    voiceMode,
    fallbackDetail,
    isStale = () => false,
    log = defaultLogger,
    saveUsageFn = defaultSaveUsage,
  } = opts;
  const meters = new Map<string, MeterEntry>();

  const addMeter = (
    technology: string,
    label: string | undefined,
    unit: string,
    quantity: number | undefined,
  ): void => {
    if (!quantity || quantity <= 0) return;
    // Realtime models bundle STT+TTS into the model charge — never emit separate
    // stt/tts rows for them (mirrors voice-agent-runtime's addMeter gate).
    if (voiceMode === "realtime" && (technology === "stt" || technology === "tts")) return;
    // Prefer the configured vendor/model; fall back to the SDK label then the
    // supplied fallbackDetail (kept identical to voice-agent-runtime's addMeter).
    const resolved = usageVendors[technology as keyof UsageVendors];
    const detail = resolved?.detail || label || fallbackDetail;
    const provider =
      resolved?.vendor || (label ? label.split(/[./]/)[0] || undefined : undefined);
    const key = `${technology}|${detail}`;
    const meter = meters.get(key) || { technology, provider, detail, units: {} };
    meter.units[unit] = (meter.units[unit] || 0) + quantity;
    meters.set(key, meter);
  };

  const onMetrics = (m: any): void => {
    try {
      switch (m?.type) {
        case "llm_metrics":
          addMeter("llm", m.label, "input_tokens", m.promptTokens);
          addMeter("llm", m.label, "output_tokens", m.completionTokens);
          addMeter("llm", m.label, "cache_read_tokens", m.promptCachedTokens);
          break;
        case "realtime_model_metrics":
          addMeter("llm", m.label, "input_tokens", m.inputTokens);
          addMeter("llm", m.label, "output_tokens", m.outputTokens);
          addMeter("llm", m.label, "cache_read_tokens", m.inputTokenDetails?.cachedTokens);
          break;
        case "tts_metrics":
          addMeter("tts", m.label, "characters", m.charactersCount);
          addMeter("tts", m.label, "milliseconds", m.audioDurationMs);
          break;
        case "stt_metrics":
          addMeter("stt", m.label, "milliseconds", m.audioDurationMs);
          break;
        default:
          break;
      }
    } catch (e) {
      log.debug({ e }, "usage metrics accumulation failed");
    }
  };

  const wire = (s: voice.AgentSession): void => {
    s.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => {
      if (isStale(s)) return;
      onMetrics(ev?.metrics);
    });
    s.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev: any) => {
      if (isStale(s)) return;
      if (ev?.isFinal && typeof ev?.transcript === "string") {
        addMeter("stt", undefined, "characters", ev.transcript.length);
      }
    });
  };

  const flush = async (finalised: boolean): Promise<void> => {
    try {
      const c = getCall();
      if (!c?.id) return;
      const records: UsageRecordPayload[] = [];
      for (const meter of meters.values()) {
        for (const [unit, quantity] of Object.entries(meter.units)) {
          if (!quantity) continue;
          records.push({
            sessionId: c.id,
            callId: c.id,
            organisationId: c.organisationId,
            userId: c.userId,
            agentId: c.agentId,
            technology: meter.technology,
            provider: meter.provider,
            detail: meter.detail,
            unit,
            quantity,
            mode: "set",
            finalised,
          });
        }
      }
      if (records.length) await saveUsageFn(records);
    } catch (e) {
      log.warn({ e }, "failed to flush usage to ledger");
    }
  };

  return { wire, flush };
}
