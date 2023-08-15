const Application = require('../../../../lib/application');

let appParameters, log;

module.exports =
  function (logger) {

    log = logger;

    const callsList = (async (req, res) => {
      let { agentId } = req.params;
      let application = Application.recover(agentId);
      if (!application) {
        res.status(404).send(`no agent ${agentId}`);
      }
      else {

        calls = Object.entries(application.agent.sessions)
          .map(([id, call]) => ({id, from: call?.session?.from, to: call?.session?.to }));
        logger.info({ application, calls }, 'calls');
        res.send(calls);
      }
    });
    callsList.apiDoc = {
      summary: 'Returns list of calls in progress to this agent',
      operationId: 'callsList',
      tags: ["Calls"],
      parameters: [
        {
          description: "ID of the parent agent",
          in: 'path',
          name: 'agentId',
          required: true,
          schema: {
            type: 'string'
          }
        }
      ],
      responses: {
        200: {
          description: 'A list of in progress calls',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  $ref: '#/components/schemas/Call'
                }
              },
              example: [
                { id: "648aa45d-204a-4c0c-a1e1-419406254134", from: "+443300889471", to: "+442080996945" },
                { id: "632555d87-948e-48f2-a53d-fc5f261daa7", from: "+443300889470", to: "+442080996945" },
              ]
            }
          }
        },
        default: {
          description: 'An error occurred',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error'
              }
            }
          }
        }

      }
    };


    return {
      GET: callsList
    };



  };