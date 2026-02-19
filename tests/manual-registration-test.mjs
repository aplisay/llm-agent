#!/usr/bin/env node

/**
 * Manual test script for agent registration workflow using the HTTP API
 * 
 * This script:
 * 1. Creates an agent using existing test data
 * 2. Prompts for registration endpoint details (or uses TEST_... env vars)
 * 3. Creates a registration endpoint and gets its ID
 * 4. Activates that endpoint
 * 5. Polls registration state until it becomes "registered"
 * 6. Creates a listener instance of the agent using the registration endpoint ID
 * 7. Pauses for user input
 * 8. Cleans up: removes listener, deactivates endpoint, removes endpoint, deletes agent
 * 
 * Usage:
 *   node tests/manual-registration-test.mjs
 * 
 * Environment variables (required):
 *   API_KEY - API key for authentication (from .env file)
 *   TEST_REGISTRAR - SIP registrar URI (e.g., sip.example.com:5060)
 *   TEST_USERNAME - SIP username
 *   TEST_PASSWORD - SIP password
 *   TEST_TRANSPORT - Transport protocol (udp, tcp, tls) - defaults to tls
 * 
 * Environment variables (optional):
 *   API_BASE_URL - Base URL for the API (default: http://localhost:4000/api)
 *   TEST_AGENT_FIXTURE - Agent fixture to use (default: test-agent-base)
 *                        Options: test-agent-base, test-agent, blind-transfer-agent, consultative-transfer-agent
 *   TEST_REGISTER_PROXY - Register proxy setting (if set, will be added to registration options)
 *   TEST_REALM - SIP realm setting (if set, will be added to registration options)
 *   TEST_FORCE_BRIDGED - Force bridged setting (default: false, set to "true" or "1" to enable)
 */

import readline from 'readline';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

// Load environment variables from .env file
dotenv.config();

const API_KEY = process.env.API_KEY;
// SERVICE_BASE_URI is the base host (e.g., http://localhost:5000), we need to append /api
const SERVICE_BASE = process.env.TEST_API_SERVER || process.env.CONFIG_SERVER_BASE || process.env.API_BASE_URL || 'http://localhost:4000';
const API_BASE_URL = SERVICE_BASE.endsWith('/api') ? SERVICE_BASE : `${SERVICE_BASE.replace(/\/$/, '')}/api`;

if (!API_KEY) {
  console.error('❌ Error: API_KEY environment variable is required');
  console.error('   Please set API_KEY in your .env file');
  process.exit(1);
}

// Helper to make HTTP requests
async function apiRequest(method, path, body = null) {
  const fullUrl = path.startsWith('/') 
    ? `${API_BASE_URL.replace(/\/$/, '')}${path}` 
    : `${API_BASE_URL.replace(/\/$/, '')}/${path}`;

  const config = {
    method,
    url: fullUrl,
    headers: {
      'Authorization': `Bearer ${API_KEY}`
    }
  };

  if (body !== null) {
    config.headers['Content-Type'] = 'application/json';
    config.data = body;
  }

  try {
    const response = await axios(config);
    return { status: response.status, body: response.data };
  } catch (error) {
    const message = error.response 
      ? `API request failed: ${error.response.status} ${error.response.statusText}\n${JSON.stringify(error.response.data, null, 2)}`
      : `Request error: ${error.message}`;
    throw new Error(message);
  }
}

// Helper to prompt for user input
function promptInput(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Helper to fetch raw call recording audio for a given callId
async function fetchCallRecording(callId) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = `${base}/calls/${callId}/recording`;

  try {
    const response = await axios({
      method: 'GET',
      url,
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      },
      // We expect raw audio bytes when using server-managed encryption keys
      responseType: 'arraybuffer',
      // Treat 404 as a valid response we handle explicitly
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404
    });

    return { status: response.status, body: response.data };
  } catch (error) {
    const message = error.response
      ? `Recording request failed: ${error.response.status} ${error.response.statusText}\n${JSON.stringify(error.response.data, null, 2)}`
      : `Recording request error: ${error.message}`;
    throw new Error(message);
  }
}

// Helper to pause and wait for user input
function pause(message = 'Press Enter to continue with cleanup...') {
  return promptInput(`\n${message}\n`);
}

// Helper to convert agent fixture to API format
function convertAgentToApiFormat(selectedAgent) {
  // Transform functions array from test data format to API format
  const convertedFunctions = (selectedAgent.functions || []).map(func => {
    // If function already has input_schema, pass it through verbatim
    if (func.input_schema) {
      return func;
    }
    
    // If function has parameters, convert from parameters format
    if (func.parameters) {
      const properties = {};
      func.parameters.forEach(param => {
        properties[param.name] = {
          type: param.type,
          source: param.source,
          from: param.from,
          description: param.description,
          in: param.in || 'query'
        };
      });
      
      return {
        implementation: func.implementation,
        platform: func.platform,
        name: func.name,
        description: func.description,
        url: func.url,
        method: func.method,
        key: func.key,
        input_schema: { properties }
      };
    }
    
    // If neither input_schema nor parameters, create empty input_schema
    return {
      implementation: func.implementation,
      platform: func.platform,
      name: func.name,
      description: func.description,
      url: func.url,
      method: func.method,
      key: func.key,
      input_schema: { properties: {} }
    };
  });

  // Handle both prompt formats: object with value property or string
  const promptValue = typeof selectedAgent.prompt === 'string' 
    ? selectedAgent.prompt 
    : (selectedAgent.prompt?.value || '');

  return {
    name: selectedAgent.name,
    description: selectedAgent.description,
    modelName: selectedAgent.modelName,
    prompt: promptValue,
    options: selectedAgent.options || {},
    functions: convertedFunctions,
    keys: selectedAgent.keys || []
  };
}

// Helper to wait for keystroke input
function waitForKeystroke(message) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    console.log(message);
    process.stdout.write('> ');

    const handler = (char) => {
      if (char === '\u0003') { // Ctrl+C
        stdin.setRawMode(wasRaw);
        stdin.pause();
        process.exit(0);
      }
      
      const key = char.toLowerCase();
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', handler);
      resolve(key);
    };

    stdin.on('data', handler);
  });
}

// Helper to play a recording buffer using a system audio player
async function playAudioBuffer(buffer, callId) {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `llm-agent-recording-${callId || Date.now()}.wav`);

  await fs.promises.writeFile(filePath, buffer);

  // On macOS use afplay, otherwise fall back to ffplay if available
  const player = process.platform === 'darwin' ? 'afplay' : 'ffplay';
  const args = player === 'afplay' ? [filePath] : ['-autoexit', '-nodisp', filePath];

  console.log(`Playing recording for call ${callId} using ${player} from ${filePath}...`);

  return new Promise((resolve, reject) => {
    const child = spawn(player, args, { stdio: 'inherit' });

    child.on('error', (err) => {
      console.warn(`⚠ Failed to start player "${player}": ${err.message}`);
      resolve();
    });

    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        console.warn(`⚠ Player "${player}" exited with code ${code}`);
        resolve();
      }
    });
  });
}

// Small helper to sleep without keeping the event loop alive
function sleepUnref(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') {
      t.unref();
    }
  });
}

// Helper to poll for completed calls on an agent and play their recordings.
// Accepts a shouldStop callback so callers can signal early termination.
async function waitForCompletedCallsAndPlayRecordings(agentId, shouldStop = () => false) {
  console.log('\n=== Step 7b: Polling for completed calls and playing recordings ===');

  const processedCalls = new Set();
  const maxAttempts = 20; // up to ~10 minutes at 30s intervals
  let attempt = 0;

  while (attempt < maxAttempts) {
    if (shouldStop()) {
      console.log('Recording poller stopping due to exit request.');
      break;
    }

    attempt += 1;
    console.log(`Polling for completed calls (attempt ${attempt}/${maxAttempts})...`);

    let calls = [];
    try {
      const callsRes = await apiRequest('GET', `/agents/${agentId}/calls`);
      calls = Array.isArray(callsRes.body) ? callsRes.body : (callsRes.body.items || []);
    } catch (error) {
      console.warn(`⚠ Failed to list calls for agent ${agentId}: ${error.message}`);
      break;
    }

    const completed = calls.filter((call) => call && call.id && call.endedAt && !processedCalls.has(call.id));

    if (completed.length > 0) {
      for (const call of completed) {
        console.log(`Found completed call ${call.id}. Fetching recording...`);
        try {
          const recRes = await fetchCallRecording(call.id);
          if (recRes.status === 404) {
            console.log(`No recording available for call ${call.id} (404 from /calls/{callId}/recording).`);
            processedCalls.add(call.id);
            continue;
          }

          const buffer = Buffer.from(recRes.body);
          console.log(`Fetched recording for call ${call.id} (${buffer.length} bytes).`);
          await playAudioBuffer(buffer, call.id);
          processedCalls.add(call.id);
        } catch (error) {
          console.warn(`⚠ Failed to fetch/play recording for call ${call.id}: ${error.message}`);
        }
      }

      // After processing newly completed calls, stop polling
      break;
    }

    console.log('No new completed calls found yet. Waiting 30 seconds before next poll...');
    await sleepUnref(30000);
  }

  console.log('Finished polling for completed calls.');
}

// Available agent fixtures
const AGENT_FIXTURES = {
  'test-agent-base': './fixtures/agents/test-agent-base.js',
  'test-agent': './fixtures/agents/test-agent.js',
  'blind-transfer-agent': './fixtures/agents/blind-transfer-agent.js',
  'consultative-transfer-agent': './fixtures/agents/consultative-transfer-agent.js'
};

async function main() {
  let testAgentId;
  let testRegistrationId;
  let testListenerId;

  try {
    console.log('Using API:', API_BASE_URL);
    console.log('');

    // Step 0: Select agent fixture
    console.log('=== Step 0: Select agent fixture ===');
    const agentNames = Object.keys(AGENT_FIXTURES);
    console.log('Available agent fixtures:');
    agentNames.forEach((name, idx) => {
      const marker = name === 'test-agent-base' ? ' (default)' : '';
      console.log(`  ${idx + 1}. ${name}${marker}`);
    });
    
    const selectedAgentEnv = process.env.TEST_AGENT_FIXTURE;
    let selectedAgentName;
    if (selectedAgentEnv && AGENT_FIXTURES[selectedAgentEnv]) {
      selectedAgentName = selectedAgentEnv;
      console.log(`Using TEST_AGENT_FIXTURE: ${selectedAgentName}`);
    } else {
      const answer = await promptInput(`Select agent fixture [1-${agentNames.length}] (default: 1): `);
      const selection = answer.trim() || '1';
      const idx = parseInt(selection, 10) - 1;
      if (idx >= 0 && idx < agentNames.length) {
        selectedAgentName = agentNames[idx];
      } else {
        selectedAgentName = 'test-agent-base'; // Default
      }
    }
    
    console.log(`Selected: ${selectedAgentName}`);
    const agentModule = await import(AGENT_FIXTURES[selectedAgentName]);
    const selectedAgent = agentModule.default;
    console.log(`  Name: ${selectedAgent.name}`);
    console.log(`  Description: ${selectedAgent.description || '(none)'}`);
    console.log('');

    // Step 1: Create agent using test data
    console.log('=== Step 1: Creating agent ===');
    const agentData = convertAgentToApiFormat(selectedAgent);

    const agentRes = await apiRequest('POST', '/agents', agentData);
    testAgentId = agentRes.body.id;
    console.log(`✓ Agent created with ID: ${testAgentId}`);

    // Step 2: Get registration endpoint details
    console.log('\n=== Step 2: Registration endpoint details ===');
    let registrar = process.env.TEST_REGISTRAR;
    let username = process.env.TEST_USERNAME;
    let password = process.env.TEST_PASSWORD;
    let transport = process.env.TEST_TRANSPORT || 'tls';
    let auth_username = process.env.TEST_AUTH_USERNAME || undefined;
    let register_proxy = process.env.TEST_REGISTER_PROXY || undefined;
    let realm = process.env.TEST_REALM || undefined;
    // Parse forceBridged: default to false, but allow explicit true via env var
    let forceBridged = false;
    if (process.env.TEST_FORCE_BRIDGED !== undefined) {
      const forceBridgedValue = process.env.TEST_FORCE_BRIDGED.toLowerCase().trim();
      forceBridged = forceBridgedValue === 'true' || forceBridgedValue === '1';
    }
    if (!registrar) {
      registrar = await promptInput('Enter SIP registrar (e.g., sip.example.com:5060): ');
      if (!registrar) {
        throw new Error('Registrar is required');
      }
    } else {
      console.log(`Using TEST_REGISTRAR: ${registrar}`);
    }

    if (!username) {
      username = await promptInput('Enter SIP username: ');
      if (!username) {
        throw new Error('Username is required');
      }
    } else {
      console.log(`Using TEST_USERNAME: ${username}`);
    }

    if (!password) {
      password = await promptInput('Enter SIP password: ');
      if (!password) {
        throw new Error('Password is required');
      }
    } else {
      console.log(`Using TEST_PASSWORD: ${password} ${'*'.repeat(password.length)}`);
    }

    console.log(`Using transport: ${transport}, auth_username: ${auth_username}, register_proxy: ${register_proxy || '(not set)'}, realm: ${realm || '(not set)'}, forceBridged: ${forceBridged}`);

    // Step 3: Create or update registration endpoint
    console.log('\n=== Step 3: Creating registration endpoint ===');
    const registrationData = {
      type: 'phone-registration',
      name: 'Manual Test Registration',
      handler: 'livekit',
      outbound: false,
      registrar: registrar,
      username: username,
      password: password,
      options: {
        transport: transport ? transport : undefined,
        auth_username: auth_username ? auth_username : undefined,
        register_proxy: register_proxy ? register_proxy : undefined,
        realm: realm ? realm : undefined,
        forceBridged: forceBridged || undefined,
      }
    };

    let registrationRes;
    try {
      registrationRes = await apiRequest('POST', '/phone-endpoints', registrationData);
      testRegistrationId = registrationRes.body.id;
      console.log(`✓ Registration endpoint created with ID: ${testRegistrationId}`);
    } catch (error) {
      // Check if it's a 409 Conflict (already exists)
      if (error.message.includes('409') && error.message.includes('already exists')) {
        console.log('⚠ Registration endpoint already exists. Finding existing endpoint...');
        
        // Fetch phone-registration endpoints (list now includes registrar and username)
        const endpointsRes = await apiRequest('GET', '/phone-endpoints?type=phone-registration');
        const endpoints = Array.isArray(endpointsRes.body) ? endpointsRes.body : endpointsRes.body.items || [];
        
        console.log(`Found ${endpoints.length} phone-registration endpoint(s)`);
        
        if (endpoints.length === 0) {
          throw new Error('Conflict error received but no registration endpoints found');
        }
        
        // Normalize registrar (strip sip:/sips: prefix) for comparison
        const normalizedRegistrar = registrar.replace(/^sips?:/i, '');
        
        // Find matching endpoint by registrar and username
        const existingEndpoint = endpoints.find(ep => {
          if (ep.username !== username) {
            return false;
          }
          
          // Normalize endpoint registrar for comparison
          const epRegistrar = (ep.registrar || '').replace(/^sips?:/i, '');
          
          // Try exact match
          if (epRegistrar === normalizedRegistrar) {
            return true;
          }
          
          // Try matching host:port parts separately (in case format differs slightly)
          const epParts = epRegistrar.split(':');
          const searchParts = normalizedRegistrar.split(':');
          if (epParts.length === 2 && searchParts.length === 2) {
            return epParts[0] === searchParts[0] && epParts[1] === searchParts[1];
          }
          
          return false;
        });
        
        if (existingEndpoint) {
          console.log(`✓ Found existing registration endpoint with ID: ${existingEndpoint.id}`);
          console.log(`  Existing: registrar=${existingEndpoint.registrar}, username=${existingEndpoint.username}`);
          testRegistrationId = existingEndpoint.id;
          
          // Update the existing endpoint with current password and options
          console.log('Updating existing endpoint with current settings...');
          const updateOptions = {};
          if (transport) updateOptions.transport = transport;
          if (auth_username) updateOptions.auth_username = auth_username;
          if (register_proxy) updateOptions.register_proxy = register_proxy;
          if (realm) updateOptions.realm = realm;
          updateOptions.forceBridged = forceBridged;
          const updateData = {
            password: password,
            options: Object.keys(updateOptions).length > 0 ? updateOptions : undefined
          };
          await apiRequest('PUT', `/phone-endpoints/${testRegistrationId}`, updateData);
          console.log('✓ Endpoint updated');
        } else {
          console.error('Could not find matching endpoint. Available phone-registration endpoints:');
          endpoints.forEach(ep => {
            console.error(`  - ID: ${ep.id}, registrar: ${ep.registrar || '(none)'}, username: ${ep.username || '(none)'}`);
          });
          throw new Error('Conflict error received but could not find matching endpoint');
        }
      } else {
        throw error;
      }
    }

    // Step 4: Activate the endpoint
    console.log('\n=== Step 4: Activating registration endpoint ===');
    const activateRes = await apiRequest('POST', `/phone-endpoints/${testRegistrationId}/activate`);
    console.log(`✓ Registration endpoint activated`);
    console.log(`  Status: ${activateRes.body.status}`);
    console.log(`  State: ${activateRes.body.state}`);

    // Step 5: Poll registration state until it becomes "registered"
    console.log('\n=== Step 5: Waiting for registration to complete ===');
    let registrationState = activateRes.body.state;
    let registrationStatus = activateRes.body.status;
    let pollCount = 0;
    
    while (registrationState !== 'registered') {
      pollCount++;
      console.log(`Poll ${pollCount}: Current state: ${registrationState}, status: ${registrationStatus}`);
      
      if (registrationState === 'failed') {
        console.warn('⚠ Registration has failed. Continuing anyway...');
        break;
      }
      
      // Wait 30 seconds before next poll
      console.log('Waiting 30 seconds before next poll...');
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      // Poll the endpoint to get current state
      try {
        const statusRes = await apiRequest('GET', `/phone-endpoints/${testRegistrationId}`);
        registrationState = statusRes.body.state;
        registrationStatus = statusRes.body.status;
      } catch (error) {
        console.error(`Error polling registration status: ${error.message}`);
        break;
      }
    }
    
    if (registrationState === 'registered') {
      console.log(`✓ Registration completed! State: ${registrationState}, Status: ${registrationStatus}`);
    } else {
      console.log(`⚠ Registration polling ended. Final state: ${registrationState}, Status: ${registrationStatus}`);
    }

    // Step 6: Create listener
    console.log('\n=== Step 6: Creating listener ===');
    const listenerData = {
      id: testRegistrationId,
      // Enable call recording for this listener using server-managed encryption keys.
      // We omit the `key` so that the server generates and manages per-call keys,
      // and /calls/{callId}/recording returns raw audio we can play back directly.
      options: {
        ...(selectedAgent.options || {}),
        recording: {
          ...(selectedAgent.options?.recording || {}),
          enabled: true,
          key: null
        }
      }
    };

    try {
      const listenerRes = await apiRequest('POST', `/agents/${testAgentId}/listen`, listenerData);
      testListenerId = listenerRes.body.id;
      console.log(`✓ Listener created with ID: ${testListenerId}`);
    } catch (err) {
      // Handle case where registration is already linked to an instance
      const msg = err.message || '';
      const match = /already linked to instance ([0-9a-fA-F-]{36})/.exec(msg);
      if (match && match[1]) {
        const existingListenerId = match[1];
        console.warn(`⚠ Registration already linked to listener ${existingListenerId}. Deleting and retrying...`);
        try {
          await apiRequest('DELETE', `/listener/${existingListenerId}`);
          console.log('✓ Deleted existing listener');
        } catch (delErr) {
          console.warn(`⚠ Failed to delete existing listener ${existingListenerId}: ${delErr.message}`);
        }
        const retryRes = await apiRequest('POST', `/agents/${testAgentId}/listen`, listenerData);
        testListenerId = retryRes.body.id;
        console.log(`✓ Listener created after cleanup with ID: ${testListenerId}`);
      } else {
        throw err;
      }
    }

    // Step 7: Active session with keystroke controls
    console.log('\n=== Step 7: Active session ===');
    console.log(`Agent ID: ${testAgentId}`);
    console.log(`Registration ID: ${testRegistrationId}`);
    console.log(`Listener ID: ${testListenerId}`);

    // Shared flag so we can stop the recording poller when the user exits.
    let stopRecordingPoller = false;

    // Start polling for completed calls and playing their recordings in parallel
    // with the interactive session loop. We use server-managed encryption keys,
    // so /calls/{callId}/recording returns raw audio that we can play directly.
    const recordingPoller = waitForCompletedCallsAndPlayRecordings(
      testAgentId,
      () => stopRecordingPoller
    ).catch((err) => {
      console.warn(`⚠ Recording poller error: ${err.message}`);
    });

    let sessionActive = true;
    while (sessionActive) {
      const key = await waitForKeystroke('\nSession is active. Press [U] to update agent, [X] to exit:');
      
      if (key === 'u') {
        console.log('\nUpdating agent from file...');
        try {
          // Re-read the agent fixture file with cache busting
          // Resolve relative path and append timestamp query to bust ES module cache
          const fixturePath = AGENT_FIXTURES[selectedAgentName];
          const fileUrl = new URL(fixturePath, import.meta.url).href + `?t=${Date.now()}`;
          
          // Import with cache-busting query parameter
          const agentModule = await import(fileUrl);
          const updatedAgent = agentModule.default;
          
          // Convert to API format
          const updatedAgentData = convertAgentToApiFormat(updatedAgent);
          
          // Update the agent via PUT request
          await apiRequest('PUT', `/agents/${testAgentId}`, updatedAgentData);
          console.log(`✓ Agent updated successfully`);
          console.log(`  Name: ${updatedAgent.name}`);
        } catch (error) {
          console.error(`❌ Failed to update agent: ${error.message}`);
        }
      } else if (key === 'x') {
        console.log('\nExiting session...');
        sessionActive = false;
        // Signal the recording poller to stop as soon as possible.
        stopRecordingPoller = true;
      } else {
        console.log(`\nUnknown key: ${key}. Press [U] to update, [X] to exit.`);
      }
    }

    // Step 8: Cleanup
    console.log('\n=== Step 8: Cleanup ===');

    // Delete listener
    if (testListenerId) {
      console.log('Deleting listener...');
      try {
        await apiRequest('DELETE', `/listener/${testListenerId}`);
        console.log('✓ Listener deleted');
      } catch (error) {
        console.warn(`⚠ Failed to delete listener: ${error.message}`);
      }
    }

    // Disable registration
    if (testRegistrationId) {
      console.log('Disabling registration endpoint...');
      try {
        await apiRequest('POST', `/phone-endpoints/${testRegistrationId}/disable`);
        console.log('✓ Registration endpoint disabled');
      } catch (error) {
        console.warn(`⚠ Failed to disable registration: ${error.message}`);
      }
    }

    // Delete registration endpoint
    if (testRegistrationId) {
      console.log('Deleting registration endpoint...');
      try {
        await apiRequest('DELETE', `/phone-endpoints/${testRegistrationId}`);
        console.log('✓ Registration endpoint deleted');
      } catch (error) {
        console.warn(`⚠ Failed to delete registration: ${error.message}`);
      }
    }

    // Delete agent
    if (testAgentId) {
      console.log('Deleting agent...');
      try {
        await apiRequest('DELETE', `/agents/${testAgentId}`);
        console.log('✓ Agent deleted');
      } catch (error) {
        console.warn(`⚠ Failed to delete agent: ${error.message}`);
      }
    }

    console.log('\n✓ Cleanup complete!');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the script
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
