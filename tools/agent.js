#!/usr/bin/env node
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs/promises');
const WebSocket = require('ws');
const axios = require('axios');
const commandLineArgs = require('command-line-args');
const optionDefinitions = [
  { name: 'command', defaultOption: true },
  { name: 'file', alias: 'f', type: String, defaultValue: "agent.json" },
  { name: 'number', alias: 'n', type: String, defaultValue: '*' },
  { name: 'key', alias: 'k', type: String, defaultValue: process.env.API_KEY },
  { name: 'agent', alias: 'a', type: String },
  { name: 'server', alias: 's', type: String, defaultValue: 'https://llm-agent.aplisay.com' },
  { name: 'help', alias: 'h', type: Boolean, defaultValue: false }
];
const options = commandLineArgs(optionDefinitions);

let api = axios.create({
  baseURL: `${options.server}/api`,
  headers: { 'Authorization': `Bearer ${options.key}` }
});

let command = options.command && options.command.toLowerCase();

if (!command || command === 'help' || options.help) {
  console.log(`Usage: ${process.argv[1]} command [options]`);
  console.log(`Commands: start, stop, dev`);
  console.log(`Options: --file, --number, --key --agent`);
  console.log(`Examples: ${process.argv[1]} start --file agent.json --number 1234567890 --key NCmQg2Pgd3bCBssUPzEPJToREPt4Upqgm6UmU52C9uM9gI19`);
  console.log(`          ${process.argv[1]} dev --file agent.json --number 1234567890 --key NCmQg2Pgd3bCBssUPzEPJToREPt4Upqgm6UmU52C9uM9gI19`);
  !command && !options.help && console.error("Please specify a command");
  exit(1);
}
else {
  run(command, options).then(() => {
    console.log("Operation complete.");
  }).catch((err) => {
    console.error(err);
    exit(1);
  });
}

// This is global so that we can do a tidy cleanup if the user hits ^c during a dev (debug) session
//  to release resources without an explicit stop
let agentId;


async function run(command, options) {
  let { file, number, server } = options;
  let instance;
  let agentData = await fs.readFile(path.resolve(file), { encoding: 'utf8' });
  let agent = await JSON.parse(agentData);

  switch (command) {
    case 'start':
      instance = await start(agent, { number });
      break;
    case 'dev':
      instance = await start(agent, { number, trace: true });
      await debugTrace(instance, server);
      break;
    case 'stop':
      await stop(options.agent);
      break;
    default:
      throw new Error(`Unknown command ${command}`);
      break;
  }
}

const transformFunctions = (functions) => functions?.map?.(({ name, description, parameters, url, implementation, method, key }) => {
  let pUrl = new URL(url);
  return {
    name,
    description,
    url,
    implementation,
    method,
    key,
    input_schema: {
      type: "object",
      properties:
        parameters?.reduce((o, p) => {
          let isIn = pUrl.pathname.includes(`{${p.name}}`) && 'path';
          isIn = isIn || (pUrl.searchParams.has(p.name) && 'query');
          isIn = isIn || (method === 'post' && 'body');
          return {
            ...o, [p.name]: {
              type: p.type,
              in: isIn,
              description: p.description
            }
          };
        }, {}) || {},
    }
  };
});

async function start(agent, { number, trace }) {
  let { prompt: { value: prompt }, modelName, functions: functionSpec, keys, options } = agent;
  functions = transformFunctions(functionSpec);
  ({ data: { id: agentId } } = await api.post('/agents', { modelName, prompt, options, functions, keys }));
  ({ data: { socket, id: listenerId, number } } = await api.post(`/agents/${agentId}/listen`, { number, options: { streamLog: !!trace } }));
  console.log(`agent ${agentId}, listener on ${number}`);
  return { socket, listenerId, agentId };
}

async function stop(agentId) {
  if (!agentId) {
    throw new Error('No agent id');
  }
  let { data } = await api.delete(`/agents/${agentId}`);
  console.log(`Deleted agent ${agentId} and all listeners`);
}

function debugTrace({ socket: url, listenerId },  server) {
  if (!socket) {
    throw new Error('No socket');
  }
  let stream = new WebSocket(`${server}${url}`);
  return new Promise((resolve, reject) => {
    stream.on('open', () => {
      console.log('connected');
    });
    stream.on('message', (data) => {
      try {
        let message = JSON.parse(data.toString());     
        console.log(message);
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

function exit(code) {
  process.exitCode = code;
}


process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  if (command === 'dev' && agentId) {
    await stop(agentId);
  }
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}


