require('dotenv').config();
const { v4: uuid } = require('uuid');
const Llm = require('./llm');
const { VertexAI, HarmCategory, HarmBlockThreshold } = require('@google-cloud/vertexai');
const { GOOGLE_PROJECT_ID } = process.env;


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
   * Gemini Pro (only) via the VertexAI API supports function calling
   *
   * @static
   * @memberof Google
   */
  static supportsFunctions = () => true;
  static needKey = { GOOGLE_PROJECT_ID };

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
  constructor({ logger, user, prompt, functions, options = {}, location, model }) {
    super(...arguments);
    Object.assign(this, { options, model });
    this.vertexAi = new VertexAI({ project: project, location: location });

  }

  set prompt(newPrompt) {
    // Because there is no concept of a "system" prompt, we basically have to restart the chat
    this._prompt = newPrompt;
    this.started && this.initial();
  }

  set functions(functions) {
    this.tools = functions && [{
      functionDeclarations: functions.map(({ name, description, input_schema }) => ({
        name,
        description,
        parameters: input_schema
      }))
    }];
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
  async initial(callBack) {
    this.logger.debug({ tools: this.tools, model: !!this.generativeModel }, 'starting chat with tools');
    let { temperature = 0 } = this.options || {};
    // Instantiate models
    this.generativeModel = this.vertexAi.preview.getGenerativeModel({
      model: this.model,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature,
        topP: 1,
      },
      tools: this.tools?.[0]?.functionDeclarations?.length ? this.tools : undefined,
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
    },
      { apiVersion: "v1beta" },
    );
    this.chat = this.generativeModel && this.generativeModel.startChat(this.tools?.[0]?.functionDeclarations?.length ? this.tools : {});
    this.started = true;
    return this.rawCompletion(this._prompt || this.initialPrompt, callBack);
  };


  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from Google model 
   * @memberof Google
   */
  async rawCompletion(input, callBack) {
    let calls, completion;
    let result;
    try {
      // Transient errors can occur and they leave the chat history within the 
      //  chat in a broken state by leaving the user as the last turn.
      // All further attempts to get a completion will then fail in this session
      // We resolve this by popping the previous user response from the history if
      //  we enter here with a user input as the end of the history as it is a shouldn't happen
      while (this.chat.history?.length && this.chat.history[this.chat.history.length - 1].role === 'user') {
        this.logger.debug({ item: this.chat.history[this.chat.history.length - 1] }, 'popping user response');
        this.chat.history.pop();
      }
      this.logger.debug({ input, history: this.chat.history }, 'sending input');
      result = await this.chat.sendMessage(input);
      completion = result.response.candidates?.[0]?.content?.parts?.[0].text;
      calls = result.response.candidates?.[0]?.content?.parts?.filter(part => part.functionCall)
        .map(({ functionCall: { name, args } }) => ({ name, id: uuid(), input: args }));
      this.logger.debug({ result, candidates: result.candidates, history: this.chat.history, completion, calls }, 'got response');
    }
    catch (e) {
      this.logger.error({ stacktrace: e.stack }, `${e.message} error in completion`);
      if (!completion?.length)
        return { text: "Sorry, please could you repeat that", error: e.message };
    }
    callBack && callBack({ text: completion, calls });
    return { text: completion, calls };
  }

  /**
    * Send a set of function call results back to generate the next round of responses
    * 
    * @param {Array} Array of id, result string tuples 
    * @returns the rawCompletion output 
    * @memberof OpenAi
    */
  async callResult(results) {
    let result = null;
    let response = results.map(({ name, result }) => {
      let content;
      try {
        content = JSON.parse(result);
      }
      catch (e) {
        content = result;
      }
      return {
        functionResponse: {
          name,
          response: {
            name,
            content
          },
        }
      };
    });
    // For some reason Gemini Pro 1.5 preview often fails to process function results in an obscure way
    //  it generates empty call results which then throw with a null object deref deep within their
    //  SDK. Sometimes it works on the 2nd or 3rd retry, sometimes the session is borked and function calls
    //  then don't work for this history. Needs more investigation to work out the parameters but for now 
    //  it is an experimental preview so just do our best then let the session fail (issue doesn't exist in 1.0)
    for (let tries = 3; (!result || result.error) && tries; tries--) {
      result = await this.rawCompletion(response);
      if (result.error) {
        await new Promise(r => setTimeout(r, 1000));
      }
      else {
        this.logger.debug({ response, result, gpt: this.gpt }, 'call response');
        return result;
      }
    }
    return result;
  }
}

module.exports = Google;
