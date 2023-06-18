const Application = require('../lib/application');

let appParameters, log;

module.exports = 
function ({ logger, makeService }) {
    (appParameters = {
      logger,
      makeService
    });
    log = logger;
    return {
      agentList,
      agentCreate,
      agentDelete
    };
  };

async function agentList(req, res) {
  res.send(Application.listAgents().map(([name]) => name));
}

async function agentCreate(req, res) {
  let { agentName, prompt, options } = req.body;
  log.info({ agentName, body: req.body }, 'create');

  if (!Application.agents[agentName]) {
    res.status(405).send(`no agenty for ${agentName}`);
  }
  else {

    try {
      let application = new Application({ ...appParameters, agentName });
      let number = await application.create();
      log.info({ application }, `Application created on NNnumber ${number} with id ${application.id}`);
      res.send({ number, id: application.id });
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'creating agent');
    }


  }

};

async function agentDelete(req, res) {
  let { id } = req.params;
  log.info({ id }, 'delete');
  let application

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