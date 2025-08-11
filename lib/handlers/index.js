export default async function handlers() {
  const implementations = (await Promise.all(
    [
      import('./jambonz.js'),
      import('./livekit.js'),
      import('./ultravox.js'),
    ]
  ))
  .map(({ default: h }) => h);

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
