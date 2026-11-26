// The rules every test file runs under: made-up provider settings
// (tests/setup/made-up-settings.js), no connection to another machine
// (tests/setup/no-outside-network.cjs), and fixed answers for the vendor
// catalogue requests (tests/setup/vendor-stand-ins.js).
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import axios from 'axios';
import nodeFetch from 'node-fetch';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { madeUpSettings, removedSettings } from './setup/made-up-settings.js';
import { googleTextToSpeechVoices, vendorCatalogues } from './fixtures/vendor-catalogues.js';

const REFUSED = /Tests must not connect to vendor\.invalid:443/;

describe('provider settings', () => {
  test('each one has its made-up value, whatever the machine holds', () => {
    for (const [name, value] of Object.entries(madeUpSettings)) expect([name, process.env[name]]).toEqual([name, value]);
    for (const name of removedSettings) expect([name, process.env[name]]).toEqual([name, undefined]);
  });
});

describe('connections to another machine', () => {
  const connect = (...args) => new Promise((resolve) => {
    const socket = net.connect(...args);
    socket.on('error', resolve).on('connect', () => { socket.destroy(); resolve(null); });
  });

  test('are refused, by name and by address', async () => {
    expect(await connect(443, 'vendor.invalid')).toMatchObject({ code: 'ECONNREFUSED', message: expect.stringMatching(REFUSED) });
    expect(await connect({ host: '192.0.2.1', port: 443 })).toMatchObject({ code: 'ECONNREFUSED' });
  });

  test('are refused for fetch and axios, which report the reason', async () => {
    await expect(fetch('https://vendor.invalid/v1/models')).rejects.toMatchObject({ cause: { message: expect.stringMatching(REFUSED) } });
    await expect(axios.post('https://vendor.invalid/v1/models', {})).rejects.toThrow(REFUSED);
  });

  test('are refused in a child process that a test starts', () => {
    const script = "require('node:net').connect(443, 'vendor.invalid').on('error', (error) => console.log(error.message))";
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(child.stdout).toMatch(REFUSED);
  });

  test('a connection to this machine goes through', async () => {
    const server = http.createServer((req, res) => res.end(`${req.method} ${req.url}`));
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      expect(await (await fetch(`${base}/a`)).text()).toBe('GET /a');
      expect((await axios.post(`${base}/b`)).data).toBe('POST /b');
      expect(await connect(server.address().port, 'localhost')).toBeNull();
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });
});

describe('vendor catalogue requests', () => {
  test.each(Object.keys(vendorCatalogues))('%s is answered from the fixture, through each client', async (url) => {
    const { origin, pathname } = new URL(url);
    const response = await fetch(url);
    expect([response.status, await response.json()]).toEqual([200, vendorCatalogues[url]]);
    expect(await (await fetch(new Request(`${url}?limit=100`))).json()).toEqual(vendorCatalogues[url]);
    expect(await (await nodeFetch(url, { headers: { Accept: 'application/json' } })).json()).toEqual(vendorCatalogues[url]);
    expect((await axios.get(url)).data).toEqual(vendorCatalogues[url]);
    // The way lib/ asks: an instance with a base URL.
    const instance = axios.create({ baseURL: `${origin}/` });
    expect(await instance.get(pathname, { params: { cursor: 2 } })).toMatchObject({ status: 200, data: vendorCatalogues[url] });
  });

  test('each answer is a fresh copy', async () => {
    const url = 'https://api.ultravox.ai/api/voices';
    const first = (await axios.get(url)).data;
    first.results.length = 0;
    expect((await axios.get(url)).data.results.length).toBeGreaterThan(0);
  });

  test('only a GET for a catalogue is answered: the rest of a vendor is refused', async () => {
    // The made-up Jambonz host, so that this test names no real vendor in the refusal log.
    const accounts = `${madeUpSettings.JAMBONZ_SERVER}/v1/Accounts`;
    expect(vendorCatalogues[accounts]).toBeDefined();
    await expect(axios.post(accounts, {})).rejects.toThrow(/Tests must not connect to jambonz\.invalid:443/);
    await expect(fetch(accounts, { method: 'DELETE' })).rejects.toThrow('fetch failed');
    await expect(axios.get(`${madeUpSettings.JAMBONZ_SERVER}/v1/PhoneNumbers`)).rejects.toThrow(/Tests must not connect/);
  });

  test('the Google Text-to-Speech client lists the fixture voices', async () => {
    const [{ voices }] = await new TextToSpeechClient().listVoices({});
    expect(voices).toEqual(googleTextToSpeechVoices);
  });
});
