/**
 * Deepgram Aura catalog ids (`aura-athena-en`) vs LiveKit Inference voice ids (`athena`).
 * @see https://docs.livekit.io/agents/models/tts/inference/deepgram/
 */

/**
 * @param {string} voiceId
 * @returns {string}
 */
export function deepgramCatalogToInferenceVoice(voiceId) {
  const id = String(voiceId || "").trim();
  if (!id) return id;
  const m = /^aura-([a-z0-9]+)-[a-z]{2}(?:-[a-z]{2})?$/i.exec(id);
  if (m) return m[1].toLowerCase();
  return id.toLowerCase();
}

/**
 * Clone vendor → locale → voice[] tree; for `deepgram` rows set `name` to the Inference id
 * and keep the catalog id on `deepgramAuraModel` (Jambonz / legacy agents).
 *
 * @param {Record<string, Record<string, unknown[]>>} vendorTree
 * @returns {Record<string, Record<string, unknown[]>>}
 */
export function transformVoiceTreeForLiveKitPipeline(vendorTree) {
  const out = {};
  for (const [vendor, locMap] of Object.entries(vendorTree || {})) {
    if (!locMap || typeof locMap !== "object") continue;
    out[vendor] = {};
    for (const [loc, arr] of Object.entries(locMap)) {
      if (!Array.isArray(arr)) {
        out[vendor][loc] = arr;
        continue;
      }
      if (vendor.toLowerCase() !== "deepgram") {
        out[vendor][loc] = arr;
        continue;
      }
      out[vendor][loc] = arr.map((row) => {
        if (!row || typeof row !== "object" || typeof row.name !== "string") return row;
        const original = row.name.trim();
        const inference = deepgramCatalogToInferenceVoice(original);
        if (inference === original.toLowerCase()) return { ...row };
        return { ...row, name: inference, deepgramAuraModel: original };
      });
    }
  }
  return out;
}
