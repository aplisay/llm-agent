require('dotenv').config();
const aiplatform = require('@google-cloud/aiplatform');
const { EndpointServiceClient, PredictionServiceClient } = aiplatform.v1;
const { helpers } = aiplatform;

const projectId = process.env.GOOGLE_PROJECT_ID;
const location = process.env.GOOGLE_PROJECT_LOCATION;




const initialPrompt = `You work for Newco, a company that manufactures flags.

You can only chat with callers about submitting or organising the return of an order that the user has previously made. You should start the conversation with an initial greeting then do turn by turn chat awaiting user input. Do not predict user inputs.

The only products we sell are flags of just three countries: UK, US and Taiwan. These are all available in three sizes: 50cm, 1m and 5m, and two kinds of material nylon or canvas. All products are always in stock.

Our prices consist of:
  £7.50 per flag for all 50cm flags,
  £12 per flag for all 1m flags,
  £40 per flag for all 5m flags.

There is a volume discount of 5% on all orders for 10-19 flags, and 10% for all orders of 20-50 flags.

If a customer orders more than 51 flags, you should tell them the same discount rate at 20-50, but also offer to check offline with management if a discount may be available due to the quantity they are ordering.

All orders have a flat shipping cost of £9.99, except for the following postcodes:
BT - Northern Ireland 
HS - Outer Hebrides
IM - Isle of Man
ZE – Shetland Islands
IV – Inverness
KW - Kirkwall
Which are £25

VAT applies to all orders at 20% which is added to the total order and shipping cost.

Get as much information as possible from the user about what they want to do. If they want to order, you must obtain the quantity and type of products they want to order, their name and address, at a minimum. Try to only ask for one piece of information in each conversation turn. If the want to return a previous order then get the order number they want to return, name and address, and then issue them with an RMA number which corresponds to the order.

In all cases, you must get a telephone number and email from the person you are talking to and confirm all information back to them.

Once the user has given you the complete set of information you need to process an order, confirm it back to the user and, when they confirm, output it additionally on a specially formatted text line starting "\n@DATA:" and followed by all the information you have determined about the transaction in JSON format. Alway emit an @DATA line if the customer places an order.

Generate your completions as speech output using SSML markup which can be input to Google TTS.

At the end of the conversation, please end your text with "\n@HANGUP\n" on a line on its own.`;


class Llm {

  clientOptions = {
    apiEndpoint: `${location}-aiplatform.googleapis.com`
  };




  constructor(logger, user, prompt, options) {
    Object.assign(this, {
      options,
      location,
      project: projectId,
      initialPrompt: prompt || initialPrompt,
      logger: logger.child({ user }),
      endpointClient: new EndpointServiceClient(this.clientOptions),
      predictionClient: new PredictionServiceClient(this.clientOptions)
    });

    this.endpointClient = new EndpointServiceClient(this.clientOptions);
    this.predictionClient = new PredictionServiceClient(this.clientOptions);
    logger.info({}, 'client created');

    this.chat = {
      model: "chat-bison@001",
      publisher: "google",
      server: `${location}-aiplatform.googleapis.com`,
      user,
      parameters: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        topP: 1,
        topK: 40,
        ...options

      }
    };

  }

  async initial() {


    this.chat.instance = {
      context: this.initialPrompt,
      examples: [],
      messages: []
    };

    return this.rawCompletion('hello');
  };

  async rawCompletion(input) {
    this.chat.instance.messages.push({
      author: "user",
      content: input
    });

    // Construct request
    let request = {
      endpoint: `projects/${this.project}/locations/${this.location}/publishers/${this.chat.publisher}/models/${this.chat.model}`,
      instances: [helpers.toValue(this.chat.instance)],
      parameters: helpers.toValue(this.chat.parameters)
    };

    this.logger.info(request, 'sending request');

    // Run request
    let [response] = await this.predictionClient.predict(request);
    let prediction = helpers.fromValue(response.predictions[0]);

    this.logger.info({ prediction }, 'got response');
    

    this.chat.instance.messages.push({
      author: "bot",
      content: prediction?.candidates[0]?.content
    });
    return prediction?.candidates[0]?.content;
  }

  async completion(input) {

    let rawText = await this.rawCompletion(input);

    let directives = Array.from(rawText.matchAll(/([^@]*)@(DATA|HANGUP)(:\s*)?([^\n]*)?/g));

    let opts = {};

    if (directives.length) {
      opts = directives.reduce((o, d) => {
        let data;
        logger.info({ o, d });
        o.text = o.text + d[1];
        if (d[4]) {
          this.logger.info({ d4: d[4] }, 'Parsing JSON');
          try {
            data = JSON.parse(d[4]);
          }
          catch (e) {

            data = d[4];
            this.logger.error({ data, e }, 'JSON parse error');
          }
        }
        let opt = (d[2] && { [d[2].toLowerCase()]: (data || true) }) || {};
        return { ...o, ...opt };
      }, { text: '' });
    }
    opts.text = `<speak>${opts.text || rawText}</speak>`
      .replace(/\n\n/g, '<break strength="strong" />')
      .replace(/\n/g, '<break strength="medium" />');
    return opts;

  }

  async listEndpoints(logger) {
    // Configure the parent resource
    const parent = `projects/${projectId}/locations/${location}`;
    const request = {
      parent,
    };
    let result;

    // Get and print out a list of all the endpoints for this resource
    try {
      ([result] = await this.endpointClient.listEndpoints(request));
      for (const endpoint of result) {
        this.logger.info({ endpoint }, `Endpoint name`);
        if (endpoint.deployedModels[0]) {
          this.logger.info({ model: endpoint.deployedModels[0] }, `First deployed model`
          );
        }
      }
    }
    catch (e) {
    
      this.logger.error(e, 'listEndPoints error');
    }
    return result;
  }

  get voiceHints() {
    let hints = this._hints || [...new Set(this.initialPrompt.split(/[^a-zA-Z0-9]/))].filter(h => h.length > 2);
    return (this._hints = hints);
  }
}

module.exports = Llm;
