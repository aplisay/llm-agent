import logger from '../../lib/logger.js';
import { jest } from '@jest/globals';

const functions = [
  {
    name: "get_weather",
    implementation: ({ location, unit }) => `It is warm and dry in ${location}`,
    description: "Get the current weather in a given location",
    input_schema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and country, e.g. London, UK"
        },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "The unit of temperature, either 'celsius' or 'fahrenheit'"
        }
      },
      required: ["location"]
    }
  },
  {
    name: "get_time",
    implementation: ({ timezone }) => {
      let now = new Date();
      let offset = now.getTimezoneOffset();
      let utc = new Date(now.getTime() + (offset * 60 * 1000));
      let options = {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false
      };
      return utc.toLocaleTimeString('en-GB', options);
    },
    description: "Get the current time in a given time zone",
    input_schema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "The IANA time zone name, e.g. Europe/London"
        }
      },
      required: ["timezone"]
    }
  },
  {
    name: "hangup",
    implementation: ({ reason }) => `hung up for ${reason}`,
    description: "Hangup this telephone call",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "The reason we should hang up the call, optional, only if known"
        }
      }
    }
  }
];
const tools = {
  functions: functions.map(f => ({ ...f, implementation: undefined }))
};

export default function (Llm, prompt, modelName = undefined) {

  describe(modelName || 'default', () => {
    let model;

    test('Initialises', async () => {
      if (!Llm.supportsFunctions(modelName)) {
        expect(() => new Llm({ logger, user: 'user', prompt, modelName, functions: tools.functions })).toThrow('Functions not supported by this model');
        model = new Llm({ logger, user: 'user', prompt, modelName });
      }
      else {
        model = new Llm({ logger, user: 'user', prompt, modelName, functions: Llm.supportsFunctions(modelName) && tools.functions });
      }
      return expect(model).toBeInstanceOf(Llm);
    });

    jest.setTimeout(30000);

    test('initial', async () => {
      let greeting = await model.initial();
      expect(greeting).resolves.toHaveProperty('text');
      return expect((await greeting).text).toMatch(/(hi|hello|help|welcome|thank|today|good day)/i);
    });

    test('flagsinfo', () => expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text'));

    test('change prompt', () => {
      model.prompt = "you are a helpful agent talking on the telephone.";
      return expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text');
    });

    test('Weather in London', async () => {
      let request = model.completion('Use tools calls to tell me the weather in London');
      if (!Llm.supportsFunctions(modelName)) {
        return expect(request).resolves.toHaveProperty('text');
      }
      else {

        await expect(request).resolves.toHaveProperty('calls');
        let calls = (await request).calls;
        expect(calls.length).toBe(1);
        expect(calls[0]).toHaveProperty('name');
        expect(calls[0]).toHaveProperty('input');
        expect(calls[0]).toHaveProperty('id');
        expect(calls[0].name).toBe('get_weather');
        let f = functions.find(entry => entry.name === calls[0].name);
        let completion = model.callResult([{ id: calls[0].id, name: f.name, result: f.implementation(calls[0].input) }]);
        return expect(completion).resolves.toHaveProperty('text');
      }
    });


    test('Hangup function call', async () => {
      let request = model.completion('Please hangup this call using a tools call');

      if (!Llm.supportsFunctions(modelName)) {
        return expect(request).resolves.toHaveProperty('text');
      }
      else {
        await expect(request).resolves.toHaveProperty('calls');
        let calls = (await request).calls;
        expect(calls.length).toBe(1);
        expect(calls[0]).toHaveProperty('name');
        expect(calls[0]).toHaveProperty('input');
        expect(calls[0]).toHaveProperty('id');
        expect(calls[0].name).toBe('hangup');
        let f = functions.find(entry => entry.name === calls[0].name);
        let completion = model.callResult([{ id: calls[0].id, name: f.name, result: f.implementation(calls[0].input) }]);
        completion.catch(e => { console.error({ e: JSON.stringify(e, null, 4), call: calls[0] }, 'error'); });
        return expect(completion).resolves.toHaveProperty('text');
      }
    });
  });



};