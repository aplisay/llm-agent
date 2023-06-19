const Application = require('../lib/application');

let appParameters, log;

module.exports =
  function ({ logger, wsServer, makeService }) {
    (appParameters = {
      logger,
      wsServer,
      makeService
    });
    log = logger;
    return {
      agentList,
      agentCreate,
      agentUpdate,
      agentDelete
    };
  };

async function agentList(req, res) {
  res.send(Application.listAgents());
}

async function agentCreate(req, res) {
  let { agentName, prompt, options } = req.body;
  log.info({ agentName, body: req.body }, 'create');

  if (!Application.agents[agentName]) {
    res.status(405).send(`no agenty for ${agentName}`);
  }
  else {

    try {
      let application = new Application({ ...appParameters, agentName, prompt, options });
      let number = await application.create();
      log.info({ application, appParameters }, `Application created on NNnumber ${number} with id ${application.id}`);
      res.send({ number, id: application.id, socket: application.agent.socketPath });
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'creating agent');
    }


  }

};


async function agentUpdate(req, res) {
  let { prompt, options } = req.body;
  let { id } = req.params;

  let application = Application.recover(id);
  if (!application) {
    res.status(404).send(`no agent ${id}`);
  }
  else {
    application.prompt = prompt;
    application.options = { ...application.options, ...options };
    res.send(application);
  }
};

async function agentDelete(req, res) {
  let { id } = req.params;
  log.info({ id }, 'delete');
  let application;

  if (!(application = Application.recover(id))) {
    res.status(404).send(`no agent for ${id}`);
  }
  else {

    try {
      await application.destroy();
      res.send({ id });
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'deleting agent');
    }


  }

};