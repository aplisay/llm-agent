module.exports = function (Llm, prompt) {

  test('Initialises', () => {
    model = new Llm(require('../../lib/logger'), 'user', prompt);
    expect(model).toBeInstanceOf(Llm);

  });

  jest.setTimeout(30000);

  test('initial', async () => {
    await expect(model.initial()).resolves.toMatch(/(hello|help|welcome|thank|today)/i);
  });

  test('flagsinfo', async () => {
    await expect(model.completion('I would like to buy some flags')).resolves.toHaveProperty('text');
  });
};