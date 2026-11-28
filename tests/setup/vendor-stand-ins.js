// Stand-ins for the vendor catalogue endpoints, so that no test calls a vendor
// and the suite needs no provider key. jest runs this file before each test
// file (setupFiles).
//
// A GET for a URL in tests/fixtures/vendor-catalogues.js gets that body. Every
// other request goes on to the real client, and tests/setup/no-outside-network.cjs
// refuses it unless it is for this machine.
//
// The loaders in lib/ use four clients. Two are replaced here: global `fetch`
// (Cartesia, Neuphonic, xAI) and axios (Ultravox, Jambonz). The jest configs
// map the other two to test doubles: `node-fetch` (ElevenLabs) to
// tests/mocks/node-fetch.cjs, which calls the `fetch` below, and
// `@google-cloud/text-to-speech` to tests/mocks/google-text-to-speech.js.
import './no-outside-network.cjs';
import axios from 'axios';
import { vendorCatalogues } from '../fixtures/vendor-catalogues.js';

function catalogueFor(method, url) {
  // A test of "no request at all" switches the answers off, so that a request
  // reaches the guard and is refused and logged.
  if (process.env.TEST_VENDOR_STAND_INS === 'off') return undefined;
  if (String(method || 'GET').toUpperCase() !== 'GET') return undefined;
  const body = vendorCatalogues[String(url).split('?')[0]];
  // A copy, so a caller that changes its answer does not change the next one.
  return body === undefined ? undefined : structuredClone(body);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = typeof input === 'object' && input !== null && 'url' in input ? input : undefined;
  const body = catalogueFor(init?.method ?? request?.method, request ? request.url : input);
  return body === undefined ? realFetch(input, init) : Response.json(body);
};

// Instances made with axios.create() copy the default adapter, and lib/ makes
// its instances at import, after this file has run.
const realAdapter = axios.getAdapter(axios.defaults.adapter);
axios.defaults.adapter = async (config) => {
  const body = catalogueFor(config.method, axios.getUri(config));
  if (body === undefined) return realAdapter(config);
  return { data: body, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};
