const Google = require('../lib/google');
const logger = require('pino')({
  level: process.env.LOGLEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

let google;
  test('Initialises', () => {
    google = new Google(logger, 'user');
    expect(google).toBeInstanceOf(Google);
    
  });

jest.setTimeout(30000);

test('Endpoints', async () => {
  await expect(google.listEndpoints(logger)).resolves.toBeInstanceOf(Array);
});

test('initial', async () => {
  await expect(google.initial()).resolves.toContain('ello');
});

test('flagsinfo', async () => {
  await expect(google.completion('I would like to buy some flags')).resolves.toHaveProperty('text');
});