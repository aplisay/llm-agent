const { createServer } = require('http');
const server = createServer();
const Application = require('../lib/application');

let application;


let options = {
  tts: {
    vendor: "google",
    language: "en-GB",
    voice: "en-GB-Standard-A"
  },
  stt: {
    vendor: 'google',
    language: "en-GB",
  }

}


let agent = {
  server,
  options,
  logger: require('../lib/logger')
}

test('Static agent list', () => {
  expect(Application.listAgents().length).toBe(2);
  expect(Application.listAgents()[0].length).toBe(2);
  expect(Application.listAgents()[0][1]).toHaveProperty('description');
  expect(Application.listAgents()[0][1].implementation).toBeInstanceOf(Function);
});

test('No agent name', () => {
  expect(() => new Application(agent)).toThrow(/Bad agent name/i);
});

test('Instantiate', () => {
  application = new Application({ ...agent, agentName: Application.listAgents()[0][0] });
  expect(application).toBeInstanceOf(Application);
});

test('Application not null', async () => {
  return expect(application).toBeInstanceOf(Application);
});



test('create', async () => {
  let res = await expect(application.create()).resolves.toMatch(/^[0-9\+]+$/);
  expect(application.number.application_sid).toBe(application.application.application_sid);
  return res;
});

test('destroy', async () => {
  await application.destroy()
  expect(application.number).toBeUndefined();
  expect(application.application).toBeUndefined();
});

