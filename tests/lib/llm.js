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
const tools = {
  functions: functions.map(f => ({ ...f, implementation: undefined }))
}



module.exports = function (Llm, prompt, modelName = undefined) {

  test('Initialises', async () => {
    if (!Llm.supportsFunctions) {
      expect(() => new Llm({ logger: require('../../lib/logger'), user: 'user', prompt, model: modelName, functions: tools.functions })).toThrow('Functions not supported by this model');
      model = new Llm({ logger: require('../../lib/logger'), user: 'user', prompt, model: modelName });
    }
    else {
      model = new Llm({ logger: require('../../lib/logger'), user: 'user', prompt, model: modelName, functions: tools.functions });
    }
    return expect(model).toBeInstanceOf(Llm);
  });

  jest.setTimeout(30000);

  test('initial', async () => {
    let greeting = model.initial();
    expect(greeting).resolves.toHaveProperty('text');
    return expect((await greeting).text).toMatch(/(hello|help|welcome|thank|today|good day)/i);
  });
  
  test('flagsinfo', () => expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text'));

  test('change prompt', () => {
    model.prompt = "you are a helpful agent talking on the telephone.";
    return expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text');
  });

  test('Weather in London', async () => {
    let request = model.completion('What is the weather like in London');
    if (!Llm.supportsFunctions){
        return expect(request).resolves.not.toHaveProperty('calls');
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
        let completion = model.callResult([{ id: calls[0].id, name: f.name, result: f.implementation(calls[0].input) }], { functions });
        return expect(completion).resolves.toHaveProperty('text');
    }
  });
  
  
  test('Hangup function call', async () => {
    let request = model.completion('Please hangup this call')
    if (!Llm.supportsFunctions) {
      return expect(request).resolves.not.toHaveProperty('calls');
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
      let completion = model.callResult([{ id: calls[0].id, name: f.name, result: f.implementation(calls[0].input) }], { functions });
      return expect(completion).resolves.toHaveProperty('text');
    }
  }); 

};