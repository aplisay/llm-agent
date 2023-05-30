const axios = require('axios');
const gpt = axios.create({
  baseURL: 'https://api.openai.com/', method: 'post', headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
}
});

const initial = `You are operating the user service line for newco. There are two kinds of request that you are able to answer, all other requests should be referred to a human agent. The two requests you can handle are:

1) Submitting a new order for one of out products.
2) Organising the return of an order that the user has previously made.

The only products we sell are flags of just three countries: UK, US and Taiwan. These are all available in three sizes: 50cm, 1m and 5m, and two kinds of material nylon or canvas. All products are always in stock.

Get as much information as possible from the user about what they want to do. If they want to order, please obtain the quantity and type of products they want to order, and their name and address. If the want to return a previous order then get the order number they want to return, name and address, and then issue them with an RMA number which corresponds to the order.

In all cases, please get a telephone number and email from the person you are talking to and confirm all information back to them.

Once you have all of the information, confirm it back to the user and on confirmation output it additionally on a specially formatted line: @ORDER: <products> <name> <address>, <phone>, <email> for orders or @RETURN <rma number> <name> <address>, <phone>, <email> for returns.

All of your responses are being spoken using text to speech so please use full words in simple sentences rather than complex sentences, punctuation and abbreviation.

Stop your initial response at the greeting and await further user input in the chat.`;

const llm = ({ logger, makeService }) => {
  const socket = makeService({ path: '/agent' });

  socket.on('session:new', async (session) => {
    session.locals = {
      transcripts: [],
      logger: logger.child({ call_sid: session.call_sid }),
      messages: [
        {
          role: "system",
          content: initial
        }
      ],
    };
    session.locals.logger.info({ session }, `new incoming call: ${session.call_sid}`);


    session
      .on('/prompt', onUserPrompt.bind(null, session))
      .on('/record', evt => session.locals.logger.info({ evt }, `recording`))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session));
    
    try {

      let completion = gpt.post('/v1/chat/completions', {
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: session.locals.messages,
        user: session.call_sid,
        presence_penalty: 0,
        temperature: 0.2,
        top_p: 0.5
      });
      console.log('sent completion');
      let { data } = await completion
      console.log({data})
      return session
        .listen({
          url: '/agent'
        })
        .pause({ length: 0.5 })
        .say({ text: data?.choices[0]?.message?.content || "Hello, how may I help you" })
        .gather({
          input: ['speech'],
          actionHook: '/prompt',
          listenDuringPrompt: true,
          timeout: 20,
          recognizer: {
            vendor: "google",
            language: "en-UK"
          }
        })
        .send();
    }
 catch(err) {
        console.log({ err });
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
  let text, truncated = false;

  /* play a typing sound while we want for gpt3 to respond */
  session
    .play({ url: 'https://www.pacdv.com/sounds/ambience_sounds/people-talking.mp3' })
    .reply();

  if (confidence < 0.6) {
    text = 'Sorry, I didn\'t understand that.  Could you try again?';
  }
  else {
    /* get a completion from gpt3 */
    while (transcripts.length > 8) transcripts.shift();
    transcripts.push(`Human: ${transcript}`);
    const prompt = transcript;
    session.locals.messages.push({
      role: "user",
      content: prompt
    });
    logger.info({ prompt }, 'sending prompt to openai');
    try {
      let { data: completion } = await gpt.post('/v1/chat/completions',
        {
          model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
          messages: session.locals.messages,
          max_tokens: process.env.MAX_TOKENS || 132,
          user: session.call_sid
        });
      logger.info({ completion }, 'got completion from openai');
      
      transcripts.push(`AI: ${completion.choices[0].message.content}`);
      text = completion.choices[0].message.content;
      session.locals.messages.push(completion.choices[0].message);
      const paused = text
        .replace(/\n\n/g, '<break strength="strong"/>')
        .replace(/\n/g, '<break strength="medium"/>');

    } catch (err) {
      logger.info({ err }, 'GPT error');
      text = 'Sorry, I am having a bit of trouble at the moment. This is a me thing, not a you thing.';
    }
  }

  /* now send another command, interrupting the typing sound */
  session
    .gather({
      input: ['speech'],
      actionHook: '/prompt',
      listenDuringPrompt: true,
      timeout: 20,
      say: { text }
    })
    .send();
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

module.exports = { llm };
