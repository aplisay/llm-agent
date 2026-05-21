import '../logger.js';

/**
 * Canonical list of all registered handler names — single source of truth
 * for the OpenAPI enums sprinkled across the `/api` surface.
 *
 * Order matches the module-import order in `handlers()` below so that any
 * future handler added there propagates here too. Keep the two in sync.
 *
 * Used by route handlers that filter / validate the `handler` query
 * parameter (e.g. `GET /phone-endpoints?handler=<name>`).
 */
export const HANDLER_NAMES = ['jambonz', 'livekit', 'pipecat', 'ultravox'];

/**
 * Subset of HANDLER_NAMES that can own a phone endpoint or phone number
 * row directly (i.e. matches the DB-level `PhoneNumber.handler` enum in
 * `lib/database.js`). `ultravox` is intentionally absent because its
 * telephony leg is delegated to jambonz (see `UltravoxHandler.telephonyHandler`).
 *
 * Used by route handlers that validate the body of CREATE / UPDATE
 * phone-endpoint requests, where the legal handler set is narrower than
 * the read-side filter.
 */
export const TELEPHONY_HANDLER_NAMES = ['jambonz', 'livekit', 'pipecat'];

export default async function handlers() {
  let implementations = [];
  // These must be serialised rather than Promise.all'd else Jest's ESM loader looses its mind
  for (const module of ['./jambonz.js', './livekit.js', './pipecat.js', './ultravox.js']) {
    implementations.push((await import(module)).default);
  }


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

export const getHandler = async (modelName) => (await handlers()).getHandler(modelName);
export const cleanHandlers = async () => (await handlers()).clean();

// Helper function to map handler names to their telephony handler names
export const getTelephonyHandler = async (handlerName) => {
  const { implementations } = await handlers();
  const handlerClass = implementations.find(h => h.name === handlerName);
  return handlerClass?.telephonyHandler || handlerName;
};
