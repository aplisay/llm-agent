require('dotenv').config();
const Llm = require('../llm');
const aiplatform = require('@google-cloud/aiplatform');
const { EndpointServiceClient, PredictionServiceClient } = aiplatform.v1;
const { helpers } = aiplatform;

const projectId = process.env.GOOGLE_PROJECT_ID;
const location = process.env.GOOGLE_PROJECT_LOCATION;

/**
 * Implements the LLM class for Google's PaLM2 model via the Vertex AI
 * interface.
 *
 * @class Palm2
 * @extends {Llm}
 */
class Palm2 extends Llm {

  clientOptions = {
    apiEndpoint: `${location}-aiplatform.googleapis.com`
  };



  /**
   * Creates an instance of Palm2.
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @memberof Palm2
   */
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options);
    Object.assign(this, {
      location,
      project: projectId,
      endpointClient: new EndpointServiceClient(this.clientOptions),
      predictionClient: new PredictionServiceClient(this.clientOptions)
    });

    this.chat = {
      model: "chat-bison@001",
      publisher: "google",
      server: `${location}-aiplatform.googleapis.com`,
      user,
      parameters: {
        temperature: options?.temperature || 0.2,
        maxOutputTokens: 1024,
        topP: 1,
        topK: 40
      }
    };
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    let system = this.chat?.instance?.context;
    system && (system = this._prompt);
  }

  set options(newOptions) {
    newOptions?.temperature && this.chat?.parameters && (this.chat.parameters.temperature = newOptions.temperature);
  }


  /**
   * Start the chat session and return the initial greeting
   *
   * @return {string} initial response
   * @memberof Palm2
   */
  async initial() {
    this.chat.instance = {
      context: this.initialPrompt,
      examples: [],
      messages: []
    };
    return this.rawCompletion('hello');
  };

 
  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from PaLM2 model 
   * @memberof Palm2
   */
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
}

  

module.exports = Palm2;
