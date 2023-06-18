require('dotenv').config();
const axios = require('axios');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('No OpenAI api key, set OPENAI_API_KEY in server environment ;');
}

const gpt = axios.create({
  baseURL: 'https://api.openai.com/', method: 'post', headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
  }
});

const initialPrompt = `You are operating the user service line for newco. 

There are two things you can do for customers who call up:

1) Submitting a new order for one of out products.
2) Organising the return of an order that the user has previously made.

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

Get as much information as possible from the user about what they want to do. If they want to order, please obtain the quantity and type of products they want to order, and their name and address, but try to nly ask for one piece of information in each conversation turn. If the want to return a previous order then get the order number they want to return, name and address, and then issue them with an RMA number which corresponds to the order.


In all cases, please get a telephone number and email from the person you are talking to and confirm all information back to them.

Once you have all of the information, confirm it back to the user and on confirmation output it additionally on a specially formatted line starting "\n@DATA:" and followed by all the information you have determined about the transaction in JSON format. Alway emit an @DATA line if the customer places an order.

Generate your completions as speech output using SSML markup which can be input to Google TTS.

At the end of the conversation, please end your text with "\n@HANGUP\n" on a line on its own

Pause your initial response at the greeting and await further user input in the chat.

`;

class Llm {

  constructor(logger, user, prompt) {
    this.initialPrompt = prompt || initialPrompt;
    this.logger = logger.child({ user });
    this.gpt = {
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      user,
      presence_penalty: 0,
      temperature: 0.2,
      top_p: 0.5,
      messages: [
        {
          role: "system",
          content: this.initialPrompt
        }
      ]
    };
  }


  async initial() {
    let completion = gpt.post('/v1/chat/completions', this.gpt);

    let { data } = await completion;

    return data?.choices[0]?.message?.content || "Hello, how may I help you";

  }

  async completion(input) {
    this.gpt.messages.push({
      role: "user",
      content: input
    });
    this.logger.info({ input }, 'sending prompt to openai');
    let { data: completion } = await gpt.post('/v1/chat/completions',
      {
        ...this.gpt,
        max_tokens: process.env.MAX_TOKENS || 1024,
      });
    this.logger.info({ completion }, 'got completion from openai');


    this.gpt.messages.push(completion.choices[0].message);
    let rawText = completion.choices[0].message.content;
    let directives = Array.from(rawText.matchAll(/([^@]*)@(DATA|HANGUP)(:\s*)?([^\n]*)?/g));

    let opts = {};

    if (directives.length) {
      opts = directives.reduce((o, d) => {
        let data;

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

  get voiceHints() {
    let hints = this._hints || [...new Set(this.initialPrompt.split(/[^a-zA-Z0-9]/))].filter(h => h.length > 2);


    return (this._hints = hints);
  }
}

module.exports = Llm;
