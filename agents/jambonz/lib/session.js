const uuid = require('uuid').v4;
const Voices = require('../agent-lib/voices');
const { functionHandler } = require('../agent-lib/function-handler.js');

const { JAMBONZ_AGENT_NAME: server } = process.env;
const wsPath = `wss://${server}/audio`


/**
 *
 * @param {*} { progress, logger, session, llmClass, prompt, options }
 * @param {Object} params Session parameters
 * @param {string} params.path The path to this service
 * @param {Llm} params.model LLM class instance for implementation class
 * @param {WebSocket} params.progress A websocket to write progress messages to
 * @param {Object} params.logger Pino logger instance
 * @param {Object} params.session Jambonz WebSocket session object
 * @param {Object} params.options Options object containing combined STT, TTS and model options
 */
class JambonzSession {
  constructor({ path, model, progress, logger, session, options, instanceId, streamUrl }) {
    Object.assign(this, {
      path,
      model,
      logger: logger.child({ call_sid: session.call_sid }),
      callId: session.call_sid,
      progress,
      session,
      instanceId,
      streamUrl
    });
    this.options = options;
    this.waiting = {};
  }

  set prompt(newPrompt) {
    this.model.prompt = newPrompt;
  }
  set options(newValue) {
    this._options = newValue;
    newValue.tts && (this.sayOptions = {
      synthesizer: { vendor: "google", ...newValue.tts }
    });
    this.voice = Voices.services?.[newValue?.tts?.vendor];
    this.speak = this.voice?.speak || ((str) => (str));
    console.log({ options: newValue, voice: this.voice, speak: this.voice?.speak, ssml: this.voice?.useSsml }, 'options set');
    this.model && (this.model.options = this._options);
  }
  get options() {
    return this?._options;
  }


  async #waitFor(id) {
    return id ? new Promise(resolve => (this.waiting[id] = resolve)) : Promise.resolve();
  }

  handler() {
    return this.streamUrl ? this.#streamHandler() : this.#pipelineHandler();
  }

  /**
   * Handler for a Jambonz session, main wait loop that sets listeners on Jambonz and the LLM agent
   * dispatches messages between them as long as they are both responding and closes them gracefully
   * on hangup or other errors.
   * 
   * @return {Promise} Resolves to a void value when the conversation ends
   * @memberof JambonzSession
   */
  async #pipelineHandler() {
    let { session, progress, logger, model } = this;
    logger.debug({ handler: this }, `new incoming pipeline call`);
    progress && progress.send({ call: session?.from || 'unknown' });

    let sessionEnded = new Promise(resolve => {
      session
        .config({
          notifyEvents: true,
          bargeIn: {
            enable: true,
            sticky: true,
            input: ['speech'],
            actionHook: '/prompt',
          },
          recognizer: {
              vendor: "google",
              language: "en-GB",
              hints: this.model.voiceHints
            }
          
         })
        .on('/prompt', evt => this.#onUserPrompt(evt))
        .on('/record', evt => this.logger.debug({ evt }, `recording`))
        .on('verb:status', evt => {
          this.watchdog(); // something happened so reset watchdog
          this.logger.debug({ evt, waiting: this.waiting?.[evt.id] }, 'verb:status');
          if (evt.event === 'finished' && this.waiting[evt.id]) {
            this.waiting[evt.id]();
            delete this.waiting[evt.id];
          }
        })
        .on('close', (code, reason) => {
          this.#onClose(code, reason);
          resolve();
        })
        .on('error', err => this.#onError(err));
    });

    try {
      this.watchdog(() => {
        let text = `Things have gone awfully quiet, are you still there`;
        progress && progress.send({ inject: text})
        this.#say(this.speak(text));
        return () => {
          let text = `I'm sorry, I haven't heard anything from you or the AI for a while so hanging up now`
          this.#say(this.speak(text), true);
          progress && progress.send({ inject: text });
        };
      })
      logger.debug({ session, model }, 'initial gathering');
      model.initial((args) => this.#handleCompletion(args));
    }
    catch (err) {
      this.#onError(err);
    }
    await sessionEnded;
  }

  async #streamHandler() {
    let { session, logger, callId, instanceId, streamUrl } = this;
    let url = `${wsPath}/${instanceId}`;
    logger.debug({ handler: this, url }, `new incoming streaming call`);

    try {

      return await new Promise(resolve => {
        session
          .on('close', (code, reason) => {
            this.#onClose(code, reason);
            resolve();
          })
          .on('error', err => this.#onError(err))
          .on('/end', () => {
            this.#onClose();
            resolve();
          });
        session
          .answer()
          .listen({
            url,
            actionHook: '/end',
            sampleRate: 8000,
            bidirectionalAudio: {
              enabled: true,
              streaming: true,
              sampleRate: 8000
            },
            metadata: {
              streamUrl,
              instanceId,
              callId
            }
          })
          .send();


      });
      
    }
    catch (err) {
      logger.error({ err }, 'error in stream handler'); this.#onError(err);
    }

  }

  async watchdog(watchdogFcn, watchdogTimeout = 20000) {
    let { logger } = this;
    this.waitCount = this.waitCount || 3;

    const handler = () => {
      logger.debug({}, 'agent watchdog fired');
      if (Object.keys(this.waiting).length > 0 && --this.waitCount > 0) {
        logger.debug({ waiting: this.waiting, length: Object.keys(this.waiting) }, 'outstanding waits');
        this.watchdogTimer = setTimeout(handler, this.watchdogTimeout);
      }
      else {
        let newFunction = this.watchdogFcn();
        newFunction && typeof (newFunction) === 'function' && this.watchdog(newFunction, this.watchdogTimeout);
      }
    };
 
    if (watchdogFcn) {
      logger.debug({ watchdogFcn }, 'watchdog set');
      Object.assign(this, {
        watchdogFcn, watchdogTimeout
      });
    }
    else {
      this.watchdogTimer && clearTimeout(this.watchdogTimer);
      logger.debug({ watchdogFcn }, 'watchdog reset');
    }

    this.watchdogFcn && (this.watchdogTimer = setTimeout(handler, this.watchdogTimeout));
    
  }

  /**
   * Force closes a (maybe) open session, send some polite text to the caller
   * then hangup. Doesn't really do much of the cleanup, just waits for it to
   * happen
   * 
   * 
   * @return {Promise} Resolves to a void value when the conversation finally closes
   * @memberof JambonzSession
   */
  async forceClose() {
    let { session, progress, logger } = this;
    let text = 'I\'m sorry, I have to go now. Goodbye';
    progress.send({ goodbye: text });
    let closed = new Promise(resolve => session.on('close', resolve));
    this.#say(this.speak(text), true);
    await closed;
    logger.debug({}, `force close ${session.call_sid} done`);
  };
  /**
   * Inject a phrase into the conversation via TTS. Doesn't change the AI turn in any way
   *
   * @param {string} text text to be spoken into the conversation by TTS
   * @memberof JambonzSession
   * @returns {Promise} resolves when Jambonz accepts transaction
   */
  async inject(text) {
    const { logger, session, progress } = this;
    logger.debug({ text }, `Injecting phrase`);
    progress.send({ inject: text });
  }

  #say(text, hangup = false) {
    let { session, logger } = this;
    logger.debug({ text, speak: this.speak, synthesizer: { ...this.sayOptions.synthesizer } }, `saying`);
    let waitingId = uuid();
    let pipeline = text && session
      .say({ text, synthesizer: { ...this.sayOptions.synthesizer }, id: waitingId })
    pipeline && hangup && (pipeline = pipeline.hangup());
    pipeline && pipeline.send();
    return pipeline && this.#waitFor(waitingId);
  };

  onMessage(message) {
    message.function_results && this?.gotFunctionCalls(message.function_results);
  }

  async #onUserPrompt(evt) {
    let { logger, session } = this;
    logger.debug(`got speech evt: ${JSON.stringify(evt)}`);
    this.watchdog();
    switch (evt.reason) {
      case 'speechDetected':
        this.#getCompletion(evt);
        break;
      case 'timeout':
        this.#goodbye();
        break;
      default:
        session.reply();
        break;
    }
  };



  async #getCompletion(evt) {
    const { logger, session, progress, model } = this;
    const { transcript, confidence } = evt.speech.alternatives[0];
    
    this.#say(this.speak('OK...'))
    progress.send({ user: transcript });
    this.watchdog();

    logger.debug({ transcript }, 'sending prompt to LLM');
    try {
      await model.completion(transcript, (args) => this.#handleCompletion(args));
    } catch (err) {
      logger.info({ err }, 'LLM error');
    }
  };


  async #handleCompletion({ text, hangup, data, calls }) {
    const { logger, session, progress, model } = this;
    const { functions, keys } = model;
    let error;

    logger.debug({ text, hangup, data, calls, functions }, 'got completion from LLM');
    text && progress && progress.send({ agent: text });
    data && progress && progress.send({ data });
    while (calls && calls.length) {
      let waiting = this.#say(this.speak(text));
      this.watchdog();
      logger.debug({ text: this.speak(text), ...this.sayOptions, id: waiting }, 'sent text');
      let { function_results } = await functionHandler(calls, functions, keys, progress?.send)
      logger.debug({ progress, function_results }, 'got function call results');
      try {
        ({ text, hangup, data, calls, error } = {});
        ({ text, hangup, data, calls, error } = await model.callResult(function_results));
        this.watchdog();
        logger.debug({ text, hangup, data, calls, error }, 'got function completion from LLM');
        text && progress && progress.send({ agent: text });
        error && progress && progress.send({ error });
      } catch (err) {
        logger.error({ err }, 'Error sending function results');
        text = 'Sorry, I am having a bit of trouble getting the data you need at the moment. Lets try again...';
      }
      logger.debug({ waiting}, 'waiting for say completion');
      waiting && await waiting;
      logger.debug({ waiting }, 'got say completion');
    }

    text = this.speak(text || 'Sorry I seem to be having a problem at the moment');
    this.#say(text, hangup);
  };

  async #functionsFailed(calls) {
    return calls.map(call => ({ ...call, result: "Error: couldn't contact server" }));
  }


  async #goodbye() {
    let { session, progress } = this;
    let text = 'I\'m struggling to understand, please try again later';
    progress.send({ goodbye: text });
    this.#say(text, true);
  }

  async #onClose(code, reason) {
    let { session, logger, progress } = this;
    this.watchdog(() => (false), 0);
    progress.send({ hangup: true });
    logger.info({ session, code, reason }, `session ${session.call_sid} closed`);
  };

  #onError(err) {
    const { session, logger, progress } = this;
    logger.error({ err }, `session ${session.call_sid} received error`);
    let text = `Sorry, I\'m having some sort of internal issue, ${err.message} please try again later`;
    progress.send({ goodbye: text });
    this.#say(text, true);
  };
}



module.exports = JambonzSession;
