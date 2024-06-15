const Axios = require('axios');
const { response } = require('express');

let appParameters, log;

const axios = Axios.create({
  headers: {
    'Content-Type': 'application/json'
  }
});

module.exports = function (logger) {
  (appParameters = {
    logger
  });
  log = logger;
  return {
    POST: httpRequest
  };
};

const httpRequest = (async (req, res) => {
  let { request } = req.body;
  log.info({ request }, 'httpRequest');

  try {
    let { data } = await axios(request);
    log.info(data, 'httpResponse');
    res.send({ data });
  }
  catch (error) {
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      let { data, status, headers } = error.response;
      res.status(status).send({ data });

    }
    else {
      res.status(500).send({ message: error.message });
      
    }
  }

});
httpRequest.apiDoc = {
  summary: 'Makes a proxy http request on behalf of a graphical agent',
  operationId: 'httpRequest',
  tags: ["Utils"],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: "object",
          description: "The request object",
          properties: {
            request: {
              type: "object",
              description: "The request object",
              properties: {
                url: {
                  type: "string",
                  description: "The url to make the request to",
                  example: "https://www.google.com"
                },
                method: {
                  type: "string",
                  description: "The method to use for the request",
                  example: "GET"
                },
                headers: {
                  type: "object",
                  description: "The headers to send with the request",
                  example: {
                    "Content-Type": "application/json"
                  }
                },
                data: {
                  type: "object",
                  description: "The data to send with the request",
                  example: {
                    "name": "John",
                    "age": 30
                  }
                }
              },
              required: ["url"],
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Response data.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                description: 'The response data'
              }
            }
          }
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



