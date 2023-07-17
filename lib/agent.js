/**
 *
 * @param {*} { progress, logger, session, llmClass, prompt, options }
 * @param {Object} params Session parameters
 * @param {string} params.path The path to this service
 * @param {Llm} params.agent LLM class instance for implementation class
 * @param {WebSocket} params.progress A websocket to write progress messages to
 * @param {Object} params.logger Pino logger instance
 * @param {Object} params.session Jambonz WebSocket session object
 */
class JambonzSession {
  constructor({ path, agent, progress, logger, session }) {
    Object.assign(this, {
      path,
      agent,
      progress,
      logger: logger.child({ call_sid: session.call_sid }),
      session
    });
  }

  /**
   * Handler for a Jambonz session, main wait loop that sets listeners on Jambonz and the LLM agent
   * dispatches messages between them as long as they are both responding and closes them gracefully
   * on hangup or other errors.
   * 
   * @return {Promise} Resolves to a void value when the conversation ends
   * @memberof JambonzSession
   */
  async handler() {
    let { session, progress, logger, agent } = this;
    logger.info({ }, `new incoming call`);
    progress && progress.send(JSON.stringify({ call: session?.from || 'unknown' }));

    let sessionEnded = new Promise(resolve =>
      session
        .on('/prompt', evt => this.#onUserPrompt(evt))
        .on('/record', evt => this.logger.info({ evt }, `recording`))
        .on('close', (code, reason) => {
          this.#onClose(code, reason);
          resolve();
        })
        .on('error', err => this.#onError(err))
    );

    try {
      session.listen({
        url: this.path
      })
        .send();
      let completion = await agent.initial();
      logger.info({ completion }, 'Got initial completion');
      progress && progress.send(JSON.stringify({ completion }));
      completion = `<speak>${completion}</speak>`;
      session
        .pause({ length: 0.5 })
        .say({ text: completion || "Hello, how may I help you" })
        .gather({
          input: ['speech'],
          actionHook: '/prompt',
          listenDuringPrompt: true,
          timeout: 20,
          recognizer: {
            vendor: "google",
            language: "en-UK",
            hints: this.agent.voiceHints
          }
        })
        .send();
    }
    catch (err) {
      this.#onError(err);
    }
    await sessionEnded;
  }

  async #onUserPrompt(evt) {
    let { logger, session } = this;
    logger.info(`got speech evt: ${JSON.stringify(evt)}`);
    switch (evt.reason) {
      case 'speechDetected':
        this.#sendCompletion(evt);
        break;
      case 'timeout':
        this.#goodbye();
        break;
      default:
        session.reply();
        break;
    }
  };

  async #sendCompletion(evt) {
    const { logger, session, progress, agent } = this;
    const { transcript, confidence } = evt.speech.alternatives[0];
    let text, hangup, data = false;

    session
      .play({ url: 'https://llm.aplisay.com/slight-noise.wav' })
      .reply();

    if (confidence < 0.6) {
      text = 'Sorry, I didn\'t understand that.  Could you try again?';
    }
    else {
      progress.send(JSON.stringify({ prompt: transcript }));

      logger.info({ transcript }, 'sending prompt to LLM');
      try {
        ({ text, hangup, data } = await agent.completion(transcript));

        logger.info({ text, hangup, data }, 'got completion from LLM');

      } catch (err) {
        logger.info({ err }, 'GPT error');
        text = 'Sorry, I am having a bit of trouble at the moment. This is a me thing, not a you thing.';
      }
    }
    text && progress && progress.send(JSON.stringify({ completion: text }));
    data && progress && progress.send(JSON.stringify({ data }));

    text = `<speak>${text}</speak>`;
    if (hangup) {
      session
        .say({ text })
        .hangup()
        .send();
    }
    else {
      session
        .gather({
          input: ['speech'],
          actionHook: '/prompt',
          listenDuringPrompt: true,
          timeout: 20,
          say: { text }
        })
        .send();
    }
  };

  async #goodbye() {
    let { session, progress } = this;
    let text = 'I\'m struggling to understand, please try again later'
    progress.send(JSON.stringify({ goodbye: text }));
    session
      .say({ text })
      .hangup()
      .reply();
  };

  async #onClose(code, reason) {
    let { session, logger, progress } = this;
    progress.send(JSON.stringify({ hangup: true }));
    logger.info({ session, code, reason }, `session ${session.call_sid} closed`);
  };

  #onError(err) {
    const { session, logger } = this;
    logger.error({ err }, `session ${session.call_sid} received error`);
    let text = `Sorry, I\'m having some sort of internal issue, ${err.message} please try again later`;
    progress.send(JSON.stringify({ goodbye: text }));
    session
      .say({ text })
      .hangup()
      .reply();
  };

  async forceClose() {
    let { session, progress, logger } = this;
    let text = 'I\'m sorry, I have to go now. Goodbye';
    progress.send(JSON.stringify({ goodbye: text }));
    let closed = new Promise(resolve => session.on('close', resolve));
    await session
      .say({ text })
      .hangup()
      .send();
    await closed;
    logger.info({}, `force close ${session.call_sid} done`);
  };

}


/**
 *
 *
 * @param {*} { name, llmClass, logger, wsServer, makeService, prompt, options, handleClose = () => (null)}
 * @param {Object} params Application creation parameters
 * @param {string} params.name supported LLM agent name, must be one of #Application.agents
 * @param {Object=} params.wsServer  An HTTP server object to attach an progress websocket to   
 * @param {Function} params.makeService  A Jambonz WS SDK makeServer Function
 * @param {Object=} params.options Options object to pass down to the underlying LLM agent
 * @param {Object} logger Pino logger instance
 * @param {string} params.name  Globally unique id for this agent instance
 * @param {string=} prompt Initial (system) prompt to the agent
 *  
 * @return {*} 
 */
class Agent {

  sessions = {};

  constructor({ name, llmClass, logger, wsServer, makeService, prompt, options, handleClose = () => (null) }) {
    let path = `/agent/${name}`;
    let progressPath = `/progress/${name}`;
    let socket = makeService({ path });
    this.progress = { send: () => (null) };

    Object.assign(this, { name, path, socketPath: progressPath, socket, llmClass, logger, prompt, options, handleClose });


    wsServer.createEndpoint(progressPath, (ws) => {
      this.ws = ws;
      ws.send(JSON.stringify({ hello: true }));
      this.progress = { send: async (msg) => ws.send(msg) };
      ws.on('message', (message) => {
        logger.info({ message }, 'received message');
      })
        .on('close', () => this.handleClose());
    });

    logger.info({ name, path, prompt }, `creating agent on ${path}`);

    socket.on('session:new', async (session) => {
      let callId = session.call_sid;
      let s = new JambonzSession({
        ...this,
        session,
        agent: new llmClass(logger, session.call_sid, this.prompt, this.options),
        jambonz: socket
      });
      this.sessions[callId] = s;
      await s.handler();
      this.sessions[callId] = undefined;
    });

  }

  async destroy() {
    // Actively terminate any existing call sessions
    await Promise.all(Object.values(this.sessions).map(session => (session?.forceClose() || Promise.resolve())));
    // Null out the close handler, otherwise closing sockets
    //  may trigger a recursive call to our caller.
    this.handleClose = () => (null);
    this.ws?.close && this.ws.close();
    this.socket?.close && this.socket.close();
  }

}

module.exports = Agent;
