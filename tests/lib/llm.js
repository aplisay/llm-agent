const functions =  [
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




module.exports = function (Llm, prompt) {

  test('Initialises', () => {
    model = new Llm(require('../../lib/logger'), 'user', prompt);
    return expect(model).toBeInstanceOf(Llm);
  });

  jest.setTimeout(30000);

  test('initial', async () => {
    let greeting = model.initial();
    expect(greeting).resolves.toHaveProperty('text');
    return expect((await greeting).text).toMatch(/(hello|help|welcome|thank|today|good day)/i);
  });
  
  test('flagsinfo', () => expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text'));

  test('Weather in London', async () => {
    let request = model.completion('What is the weather like in London', { functions });
    if (!Llm.supportsFunctions)
      return await expect(request).rejects.toThrow('Functions not supported by this model');
    else {
        await expect(request).resolves.toHaveProperty('calls');
        let calls = (await request).calls;
        expect(calls.length).toBe(1);
        expect(calls[0]).toHaveProperty('name');
        expect(calls[0]).toHaveProperty('input');
        expect(calls[0]).toHaveProperty('id');
        expect(calls[0].name).toBe('get_weather');
        let f = functions.find(entry => entry.name === calls[0].name);
        let completion = model.callResult([{ id: calls[0].id, result: f.implementation(calls[0].input) }], { functions });
        return expect(completion).resolves.toHaveProperty('text');
    }
  });
  
  
  test('Hangup function call', async () => {
    let request = model.completion('Please hangup this call', { functions })
    if (!Llm.supportsFunctions)
      return await expect(request).rejects.toThrow('Functions not supported by this model');
    else {
      await expect(request).resolves.toHaveProperty('calls');
      let calls = (await request).calls;
      expect(calls.length).toBe(1);
      expect(calls[0]).toHaveProperty('name');
      expect(calls[0]).toHaveProperty('input');
      expect(calls[0]).toHaveProperty('id');
      expect(calls[0].name).toBe('hangup');
      let f = functions.find(entry => entry.name === calls[0].name);
      let completion = model.callResult([{ id: calls[0].id, name: calls[0].name, result: f.implementation(calls[0].input) }], { functions });
      return expect(completion).resolves.toHaveProperty('text');
    }
  }); 

};