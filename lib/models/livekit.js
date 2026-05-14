const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
import Llm from './llm.js';
import {
  livekitModelIdFlags,
  isLivekitPipelineModelId,
  buildLivekitHandlerAllModels,
} from '../../agents/livekit/dist/lib/livekit-model-registry.js';

export { livekitModelIdFlags, isLivekitPipelineModelId };

/**
 * Implements the LLM class against the Livekit model
 *
 * @class Livekit
 * @extends {Llm}
 */
class Livekit extends Llm {

  static handler = 'lk_realtime';

  /**
   * Each entry: [`${vendor}/${shortName}`, description, flags?]
   * flags: { voiceStack: 'realtime'|'pipeline', audioModel: boolean, pipeline: boolean }
   *
   * Rows are defined in `agents/livekit/lib/livekit-model-registry.mjs`.
   */
  static allModels = buildLivekitHandlerAllModels();

  static get needKey() {
    return { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL };
  }

  static supportsFunctions = (model) => true;

  /** Class default; per-model `audioModel` comes from allModels row flags in GET /models */
  static audioModel = true;


  constructor({ modelName } = {}) {
    super(...arguments);
    this.model = modelName || Livekit.allModels[0][0];
    this.logger.debug({ thisPrompt: this.prompt }, 'NEW Livekit agent');
  }
}

export default Livekit;
