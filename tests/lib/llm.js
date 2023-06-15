module.exports = function (Llm) {
  const logger = require('pino')({
    level: process.env.LOGLEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true
      }
    }
  });


  test('Initialises', () => {
    model = new Llm(logger, 'user');
    expect(model).toBeInstanceOf(Llm);

  });

  jest.setTimeout(30000);

  test('initial', async () => {
    await expect(model.initial()).resolves.toContain('ello');
  });

  test('flagsinfo', async () => {
    await expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text');
  });
};