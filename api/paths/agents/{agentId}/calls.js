const Model = require('../../../../lib/model');

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
        404: {
          description: 'Agent not found',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/NotFound'
              }
            }
          }
        },
        default: {
          description: 'Another kind of error occurred',
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
      description: `Call objects are created when an agent receives a call from an external caller
                    and are destroyed when the dialogue is complete and either agent or caller hang up.
                    \`Calls\` operations allow listing of live calls, updating agent parameters mid-call
                    for just one call, and hanging up a call by the agent.`,
      summary: 'Call objects represent live calls on the agent and may be manipulated to modify a single call',
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
      GET: callsList
    };



  };