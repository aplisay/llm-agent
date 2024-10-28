const Jambonz = require('./jambonz');
const Livekit = require('./livekit');
const Ultravox = require('./ultravox');
const Handler = require('./handler');

const implementations = [Jambonz, Livekit, Ultravox];
const models = implementations.map(h => h.availableModels).flat();

module.exports = {
  implementations,
  models,
  parseModel: (modelName) => Handler.parseName(modelName),
  getHandler: (modelName) => Handler.getHandler(modelName, implementations),
}



