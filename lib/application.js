const Gpt35 = require('./lib/gpt35');
const Palm2 = require('./lib/palm2');
const agent = require('./lib/agent');


agents = {
  'GPT-3.5': Gpt35,
  'PaLM2': Palm2
}


class Application {
  constructor(agentName) {
    this.agentName = agentName;
    this.serviceUuid = uuid.v4();
  }

  static listAgents() {
    return Object.keys(agents);
  }

}