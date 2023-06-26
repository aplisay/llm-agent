const { createServer } = require('http');
const { createEndpoint } = require('@jambonz/node-client-ws');
const logger = require('../lib/logger');
const server = createServer();
const makeService = createEndpoint({ server });
const wsServer = require('../lib/ws-handler')({ server, logger });

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

};


let agent = {
  makeService,
  wsServer,
  options,
  logger
};

describe(`application`, () => {
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

test('create', async () => {
  console.log(`creating ${application.id}`);
  let res = await expect(application.create()).resolves.toMatch(/^[0-9\+]+$/);
  console.log(`created ${application.id}`);
  expect(application.number.application_sid).toBe(application.application.application_sid);
});

test('recover', () => {
  console.log(`matching ${application.id} ${new Date()}`);
  let target = Application.recover(application.id);
  console.log(`got ${target.id} ${new Date()}`);
  expect(target).toMatchObject(application);
});


test('destroy', async () => {
  console.log(`destroying ${application.id} ${new Date()}`);
  await application.destroy();
  console.log(`destroyed ${application.id} ${new Date()}`);
  expect(application.number).toBeUndefined();
  expect(application.application).toBeUndefined();
});

test('static clean', async () => {
  await application.create();
  expect(application.number.application_sid).toBe(application.application.application_sid);
  await Application.clean();
  expect(application.number).toBeUndefined();
  expect(application.application).toBeUndefined();
});

test('static cleanAll', async () => {
  await application.create();
  expect(application.number.application_sid).toBe(application.application.application_sid);
  expect(Application.cleanAll()).resolves;
});
});