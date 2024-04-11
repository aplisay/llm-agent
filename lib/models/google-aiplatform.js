require('dotenv').config();
const Llm = require('../llm');
const aiplatform = require('@google-cloud/aiplatform');
const { EndpointServiceClient, PredictionServiceClient } = aiplatform.v1;
const { helpers } = aiplatform;

const projectId = process.env.GOOGLE_PROJECT_ID;
const location = process.env.GOOGLE_PROJECT_LOCATION;

/**
 * Implements the LLM class for Google's Google model via the Vertex AI
 * interface.
 *
 * @class Google
 * @extends {Llm}
 */
class Google extends Llm {

  clientOptions = {
    apiEndpoint: `${location}-aiplatform.googleapis.com`
  };

  /**
   * Creates an instance of Google LLM.
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @memberof Google
   */
  constructor(logger, user, prompt, options, location, model) {
    super(logger, user, prompt, options);
    this.clientOptions.apiEndpoint = `${location}-aiplatform.googleapis.com`;
    Object.assign(this, {
      location,
      project: projectId,
      endpointClient: new EndpointServiceClient(this.clientOptions),
      predictionClient: new PredictionServiceClient(this.clientOptions)
    });

    this.chat = {
      model,
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
   * @memberof Google
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
   * @return {string} the raw completion output from Google model 
   * @memberof Google
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
    return { text: prediction?.candidates[0]?.content };
  }
}

  

module.exports = Google;
