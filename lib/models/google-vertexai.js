require('dotenv').config();
const Llm = require('../llm');
const { VertexAI, HarmCategory, HarmBlockThreshold } = require('@google-cloud/vertexai');

const project = process.env.GOOGLE_PROJECT_ID;

/**
 * Implements the LLM class for Google's Vertex AI platform
 * interface.
 *
 * @class Google
 * @extends {Llm}
 */
class Google extends Llm {

  /**
   * Creates an instance of Google LLM.
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @param {string} location Google service location
   * @param {string} model Google model name
   * @memberof Google
   */
  constructor(logger, user, prompt, options, location, model) {
    super(logger, user, prompt, options, location, model);
    let vertex_ai = new VertexAI({ project: project, location: location });

    // Instantiate models
    let generativeModel = vertex_ai.getGenerativeModel({
      model,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.9,
        topP: 1,
      },
      safetySettings: [
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_ONLY_HIGH',
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_ONLY_HIGH',
        },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_ONLY_HIGH',
        },
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_ONLY_HIGH',
        }
      ],
    });

    let chat = generativeModel.startChat({});

    Object.assign(this, { generativeModel, chat });
  }

  set prompt(newPrompt) {

    // Promptswapping TODO
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
    return this.rawCompletion(this.initialPrompt);
  };

 
  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from Google model 
   * @memberof Google
   */
  async rawCompletion(input) {
    const result = await this.chat.sendMessageStream(input);
    let completion = "";
    for await (const item of result.stream) {
      completion += item.candidates[0].content.parts[0].text;
    }
    return completion;
  }
}

  

module.exports = Google;
