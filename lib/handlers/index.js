<<<<<<< HEAD
import '../logger.js';
=======
import Jambonz from './jambonz.js';
import Livekit from './livekit.js';
import Ultravox from './ultravox.js';
import Handler from './handler.js';
>>>>>>> 28b3218 (Refactor project to ESM)

export default async function handlers() {
  let implementations = [];
  // These must be serialised rather than Promise.all'd else Jest's ESM loader looses its mind
  for (const module of ['./jambonz.js', './livekit.js', './ultravox.js']) {
    implementations.push((await import(module)).default);
  }

<<<<<<< HEAD

  const Handler = (await import('./handler.js')).default;
  const models = implementations.map(h => h.availableModels).flat();
  return {
    implementations,
    models,
    parseModel: (modelName) => Handler.parseName(modelName),
    getHandler: (modelName) => Handler.getHandler(modelName, implementations, models),
    fromInstance: (instanceId) => Handler.fromInstance(instanceId, implementations, models),
    clean: Handler.deactivateAll
  };
}
=======
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
>>>>>>> 28b3218 (Refactor project to ESM)

export const getHandler = async (modelName) => (await handlers()).getHandler(modelName);
export const cleanHandlers = async () => (await handlers()).clean();

// Helper function to map handler names to their telephony handler names
export const getTelephonyHandler = async (handlerName) => {
  const { implementations } = await handlers();
  const handlerClass = implementations.find(h => h.name === handlerName);
  return handlerClass?.telephonyHandler || handlerName;
};
