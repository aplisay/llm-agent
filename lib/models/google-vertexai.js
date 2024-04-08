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
    let temperature = { options };
  
    // Instantiate models
    let generativeModel = vertex_ai.getGenerativeModel({
      model,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature,
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
    // Because there is no concept of a "system" prompt, we basically have to restart the chat
    this._prompt = newPrompt;
    this.chat = this.generativeModel && this.generativeModel.startChat({});
    return this.generativeModel && this.rawCompletion(this.initialPrompt(newPrompt));
 
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
    let completion = "";
    let result;
    try {
      this.logger.info({ input, history: this.chat.history }, 'sending input');
      result = await this.chat.sendMessage(input);
      this.logger.info({ result, candidates: result.candidates, history: this.chat.history }, 'got response');
      completion += result.response.candidates?.[0]?.content?.parts?.[0].text;
    }
    catch (e) {
      this.logger.error(e, `${e.message} error in completion`);
      // Transient errors can occur and they leave the chat history within the 
      //  chat in a broken state by leaving the user as the last turn.
      // All further attempts to get a completion will then fail in this session
      // We resolve this by asking the user (needlessly) to repeat and popping the
      // previous user response from the history.
      if (this.chat.history[this.chat.history.length - 1].role === 'user') {
        this.chat.history.pop;
      }
      if (!completion.length)
        completion = "Sorry, please could you repeat that";
    }
    return completion;
  }
}

  

module.exports = Google;
