import Jambonz from './jambonz.js';
import Livekit from './livekit.js';
import Ultravox from './ultravox.js';
import Handler from './handler.js';

const implementations = [Jambonz, Livekit, Ultravox];
const models = implementations.map(h => h.availableModels).flat();

const handlers = {
  implementations,
  models,
  parseModel: (modelName) => Handler.parseName(modelName),
  getHandler: (modelName) => Handler.getHandler(modelName, implementations, models),
  fromInstance: (instanceId) => Handler.fromInstance(instanceId, implementations, models),
  clean: Handler.deactivateAll
};

export const { parseModel, getHandler, fromInstance, clean } = handlers;
export { implementations, models };
export default handlers;



