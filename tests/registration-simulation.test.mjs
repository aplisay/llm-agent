import { jest } from '@jest/globals';

/**
 * The simulator writes to the database between its timers. A stop that lands
 * while one of those writes is in flight must end the simulation. Timers
 * started after the stop are known to nobody: they fire minutes later, in
 * whatever is running by then.
 *
 * The writes are stand-ins that the test completes by hand, so the order of
 * "stop" and "write done" is fixed and no database is needed.
 */
describe('registration simulator: a stop while a write is in flight', () => {
  let simulator;
  let writes; // one function per write in flight, oldest first; calling it completes the write

  beforeAll(async () => {
    // Read once, when the module loads.
    process.env.REG_SIM_ENABLED = 'true';
    ({ registrationSimulator: simulator } = await import('../lib/registration-simulation.js'));
  });

  beforeEach(() => {
    jest.useFakeTimers();
    writes = [];
    jest.spyOn(simulator, 'updateRegistration')
      .mockImplementation(() => new Promise((resolve) => { writes.push(resolve); }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const completeWrites = async () => {
    writes.splice(0).forEach((done) => done());
    // Lets the code waiting on those writes run on.
    await jest.advanceTimersByTimeAsync(0);
  };

  const start = async (id) => {
    const started = simulator.startSimulation(id);
    await completeWrites();
    await started;
  };

  test('a simulation left alone goes on to its later timers, and a stop clears them all', async () => {
    await start('left-alone');
    expect(jest.getTimerCount()).toBe(2);

    // The final-state timer is due within 10 seconds.
    jest.advanceTimersByTime(10000);
    await completeWrites();
    expect(simulator.getSimulationStatus('left-alone').activeTimeouts).toBe(4);
    expect(jest.getTimerCount()).toBeGreaterThanOrEqual(2);

    simulator.stopSimulation('left-alone');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a stop during the final-state write leaves no timer behind', async () => {
    await start('stopped-late');

    jest.advanceTimersByTime(10000);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    simulator.stopSimulation('stopped-late');
    await completeWrites();

    expect(jest.getTimerCount()).toBe(0);
  });

  test('a stop during the first write starts no timers', async () => {
    const started = simulator.startSimulation('stopped-early');
    simulator.stopSimulation('stopped-early');
    await completeWrites();
    await started;

    expect(jest.getTimerCount()).toBe(0);
  });

  test('starting again during the first write leaves one simulation, with one set of timers', async () => {
    const first = simulator.startSimulation('started-twice');
    const second = simulator.startSimulation('started-twice');
    await completeWrites();
    await Promise.all([first, second]);

    expect(jest.getTimerCount()).toBe(2);
    simulator.stopSimulation('started-twice');
    expect(jest.getTimerCount()).toBe(0);
  });
});
