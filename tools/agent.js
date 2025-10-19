#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import WebSocket from 'ws';
import axios from 'axios';
import commandLineArgs from 'command-line-args';
const optionDefinitions = [
  { name: 'command', defaultOption: true },
  { name: 'file', alias: 'f', type: String, defaultValue: "agent.json" },
  { name: 'number', alias: 'n', type: String, defaultValue: '*' },
  { name: 'key', alias: 'k', type: String, defaultValue: process.env.API_KEY },
  { name: 'agent', type: String },
  { name: 'call', alias: 'c', type: String },
  { name: 'all', type: Boolean, defaultValue: false },
  { name: 'webrtc', alias: 'w', type: Boolean, defaultValue: false },
  { name: 'environment', alias: 'e', type: String, defaultValue: '' },
  { name: 'verbose', alias: 'v', type: Boolean, defaultValue: false },
  { name: 'server', alias: 's', type: String, defaultValue: 'https://llm-agent.aplisay.com' },
  { name: 'help', alias: 'h', type: Boolean, defaultValue: false }
];
const options = commandLineArgs(optionDefinitions);
const progName = path.basename(process.argv[1]);

if (!options.key) {
  console.error(`Missing API key. Please set the API_KEY environment variable or use the --key option.`);
  process.exit(1);
}

let api = axios.create({
  baseURL: `${options.server}/api`,
  headers: { 'Authorization': `Bearer ${options.key}` }
});

let command = options.command && options.command.toLowerCase();

if (!command || command === 'help' || options.help) {
  console.log(`Usage: ${progName} command [options]`);
  console.log(`Commands: dev, start, stop, update, list-agents, list-calls, show-logs`);
  console.log(`Options:  --file: Path to the agent file (default: agent.json)`);
  console.log(`          --number: The number to dial (default: *)`);
  console.log(`          --webrtc: This agent will be accessed using a webrtc room`);
  console.log(`          --key: The API key (default: API_KEY environment variable)`);
  console.log(`          --agent: The agent ID `);
  console.log(`          --call: The call ID`);
  console.log(`          --all: stop all agents (default: false)`);
  console.log('          --verbose: Show verbose output (default: false)');
  console.log('          --server: The server to connect to (default: https://llm-agent.aplisay.com)');
  console.log('          --help: Show this help message');
  console.log(`Examples: ${progName} start --file agent.json --number 1234567890`);
  console.log(`          ${progName} start --file agent.json`);
  console.log(`          ${progName} dev --file agent.json --number 1234567890 --key NCmQg2Pgd3bCBssUPzEPJToREPt4Upqgm6UmU52C9uM9gI19`);
  !command && !options.help && console.error("Please specify a command");
  process.exit(1);
}
else {
  run(command, options)
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

// These are global so that we can do a tidy cleanup if the user hits ^c during a dev (debug) session
//  to release resources without an explicit stop
let agentId, stream;


async function run(command, options) {
  let { file, number, server, webrtc } = options;
  number = !webrtc ? number : undefined;
  let instance;
  switch (command) {
    case 'start':
      instance = await start(file, options);
      break;
    case 'dev':
      instance = await start(file, { ...options, trace: true });
      await debugTrace(instance, server);
      break;
    case 'stop':
      await stop(options);
      break;
    case 'update':
      await update(file, options);
      break;
    case 'list-agents':
      await list(options);
      break;
    case 'list-calls':
      await listCalls(options);
      break;
    case 'show-log':
      await showLog(options);
      break;
    default:
      throw new Error(`Unknown command ${command}`);
      break;
  }
}

const transformFunctions = (functions) => functions?.map?.(({ name, description, parameters, url, implementation, platform, method, key }) => {
  let pUrl = url?.length && new URL(url);
  return {
    name,
    description,
    url,
    implementation,
    platform,
    method,
    key,
    input_schema: {
      type: "object",
      properties:
        parameters?.reduce((o, p) => {
          let isIn = pUrl?.pathname?.includes(`{${p.name}}`) && 'path';
          isIn = isIn || (Array.from(pUrl?.searchParams?.values() || []).includes(`{${p.name}}`) && 'query');
          isIn = isIn || (method === 'post' ? 'body' : 'query');
          let { name, type, description, source, from } = p;
          return {
            ...o, [name]: {
              type,
              in: isIn,
              source,
              from,
              description
            }
          };
        }, {}) || {},
    }
  };
});

function outputEnvironment(environment, { listenerId, key, server }) {
  if (environment?.length) {
    console.log(`Use this agent in your app:`);
    console.log(`  export ${environment}_APLISAY_AGENT="${listenerId}"`);
    console.log(`  export ${environment}_APLISAY_KEY="${key}"`);
    console.log(`  export ${environment}_APLISAY_URL="${server}"`);
  }
}

async function start(file, { number, webrtc, trace, server, environment }) {
  let agentData = await fs.readFile(path.resolve(file), { encoding: 'utf8' });
  let agent = await JSON.parse(agentData);
  let { name, description, prompt: { value: prompt }, modelName, functions: functionSpec, keys, options } = agent;
  webrtc && (number = undefined);
  let socket, listenerId, key;
  const functions = transformFunctions(functionSpec);
  ({ data: { id: agentId } } = await api.post('/agents', { name, description, modelName, prompt, options, functions, keys }));
  ({ data: { socket, id: listenerId, number, key } } = await api.post(`/agents/${agentId}/listen`, { number, options: { streamLog: !!trace } }));
  let accessInfo = number ? `on ${number}` : `webrtc key ${key}`;
  console.log(`agent ${agentId}, listener ${listenerId} on ${accessInfo}`);
  webrtc && outputEnvironment(environment, { listenerId, key, server });
  return { socket, listenerId, agentId, key };
}

async function update(file, { agent: agentId }) {
  let agentData = await fs.readFile(path.resolve(file), { encoding: 'utf8' });
  let agent = await JSON.parse(agentData);
  let { name, description, prompt: { value: prompt }, modelName, functions: functionSpec, keys, options } = agent;
  functions = transformFunctions(functionSpec);
  ({ data: { id: agentId } } = await api.put(`/agents/${agentId}`, { name, description, modelName, prompt, options, functions, keys }));
  console.log(`agent ${agentId} updated`);
  return { agentId };
}

async function stop({ agent: agentId, all }) {
  if (!agentId && !all) {
    throw new Error('No agent id');
  }
  let list = [];
  if (all) {
    let { data } = await api.get('/agents');
    list = data.map(({ id }) => id);
  }
  else {
    list.push(agentId);
  }

  for (let agentId of list) {
    let { data } = await api.delete(`/agents/${agentId}`);
  }
  list.length && console.log(`Deleted agents ${list} and all listeners`);
  !list.length && console.log(`No agents to delete`);
}

async function list({ verbose, server, environment }) {
  let { data: agents } = await api.get('/agents');
  for (let a of agents) {
    const { data: agent } = await api.get(`/agents/${a.id}`);

    let functions = verbose && agent?.functions?.map(f => `${f.name}(): ${f.method} ${f.url}`);
    console.log(`agent ${agent.id} ${agent.name}: `);
    verbose && console.log(`  description: ${agent.description}`);
    verbose && console.log(`  model: ${agent.modelName}`);
    verbose && console.log(`  prompt: ${agent.prompt}`);
    verbose && console.log(`  options: ${JSON.stringify(agent.options)}`);
    verbose && console.log(`  functions: ${JSON.stringify(functions)}`);
    agent.listeners?.forEach(({ id, number, key }) => {
      let on = number?.number ? `on number ${number.number}` : `using webrtc key ${key}`;
      console.log(`  listener ${id}: ${on}`);
      outputEnvironment(environment, { listenerId: id, key, server });
    });
  };
}

async function listCalls({ agent }) {
  let next, calls;
  do {
    ({ data: { calls, next } } = await api.get(`/agents/${agent}/calls${next ? `?offset=${next}` : ''}`));
    calls.forEach(call => {
      console.log(JSON.stringify(call));
    });
    console.log('---');
  } while (next);
}

async function showLog({ call }) {
  ({ data } = await api.get(`/calls/${call}/logs`));
  data.forEach(log => {
    let { updatedAt, type, data, isFinal } = log;
    console.log(`${updatedAt} ${type}: ${data} ${!isFinal ? '(in-progress)' : ''}`);
  });
  console.log('---');
}

function debugTrace({ socket: url, listenerId }, server) {
  if (!socket) {
    throw new Error('No socket');
  }
  stream = new WebSocket(`${server}${url}`);
  return new Promise((resolve, reject) => {
    stream.on('open', () => {
      console.log('connected');
    });
    stream.on('message', (data) => {
      try {
        let message = JSON.parse(data.toString());
        process.stdout.write(`message: ${JSON.stringify(message)}`);
        process.stdout.write(message.isFinal ? '\n' : '\r');
      }
      catch (err) {
        console.log('debug decode error');
      }
    });
    stream.on('close', () => {
      console.log('disconnected');
      resolve();
    });
    stream.on('error', (err) => {
      reject(err);
    });
  });
}



process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  if (command === 'dev') {
    try {
      stream && await stream?.close();
      agentId && await stop(agentId);
    }
    catch (err) {
      // We tried to close the agents down and can get errors from various race conditions
      //  as the server also closes the listener if the WebSocket unexpectedly stops
      //  so we just ignore errors and exit at this point.
    }
  }
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}


