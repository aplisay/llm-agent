

const service = ({ name, llmClass, logger, makeService }) => {
  let path = `/agent/${name}`;
  let socket = makeService({ path });

  logger.info({ name, path });

  socket.on('session:new', async (session) => {
    session.locals = {
      logger: logger.child({ call_sid: session.call_sid }),
      agent: new llmClass(logger, session.call_sid)
    };
    session.locals.logger.info({ session }, `new incoming call: ${session.call_sid}`);


    session
      .on('/prompt', onUserPrompt.bind(null, session))
      .on('/record', evt => session.locals.logger.info({ evt }, `recording`))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session));
    
    try {
      session.listen({
        url: path
      })
        .send();
      let completion = await session.locals.agent.initial();
      logger.info({ completion}, 'Got initial completion');
      return session
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
            hints: session.locals.agent.voiceHints
          }
        })
        .send();
    }
 catch(err) {
        
 }
    
  });
};

const onUserPrompt = async (session, evt) => {
  const { logger } = session.locals;
  logger.info(`got speech evt: ${JSON.stringify(evt)}`);

  switch (evt.reason) {
    case 'speechDetected':
      sendCompletion(session, evt);
      break;
    case 'timeout':
      goodbye(session);
      break;
    default:
      session.reply();
      break;
  }
};

const sendCompletion = async (session, evt) => {
  const { logger, transcripts } = session.locals;
  const { transcript, confidence } = evt.speech.alternatives[0];
  let text, hangup, data, truncated = false;

  session
        .reply();

  if (confidence < 0.6) {
    text = 'Sorry, I didn\'t understand that.  Could you try again?';
  }
  else {
    /* get a completion from LLM */
    logger.info({ transcript }, 'sending prompt to LLM');
    try {
      ({ text, hangup, data } = await session.locals.agent.completion(transcript))

      logger.info({ text, hangup, data }, 'got completion from LLM');

    } catch (err) {
      logger.info({ err }, 'GPT error');
      text = 'Sorry, I am having a bit of trouble at the moment. This is a me thing, not a you thing.';
    }
  }

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
        say: { text },
        play: { url: 'https://www.pacdv.com/sounds/ambience_sounds/people-talking.mp3' }
      })
      .send();
  }
};

const goodbye = async (session) => {
  session
    .say({ text: 'I\'m struggling to understand, please try again later' })
    .hangup()
    .reply();
};

const onClose = (session, code, reason) => {
  const { logger } = session.locals;
  logger.info({ session, code, reason }, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const { logger } = session.locals;
  logger.info({ err }, `session ${session.call_sid} received error`);
};

module.exports = service;
