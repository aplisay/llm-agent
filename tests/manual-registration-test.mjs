#!/usr/bin/env node

/**
 * Manual test script for agent registration workflow using the HTTP API
 * 
 * This script:
 * 1. Creates an agent using existing test data
 * 2. Prompts for registration endpoint details (or uses TEST_... env vars)
 * 3. Creates a registration endpoint and gets its ID
 * 4. Activates that endpoint
 * 5. Creates a listener instance of the agent using the registration endpoint ID
 * 6. Pauses for user input
 * 7. Cleans up: removes listener, deactivates endpoint, removes endpoint, deletes agent
 * 
 * Usage:
 *   node tests/manual-registration-test.mjs
 * 
 * Environment variables (required):
 *   API_KEY - API key for authentication (from .env file)
 * 
 * Environment variables (optional):
 *   API_BASE_URL - Base URL for the API (default: http://localhost:4000/api)
 *   TEST_REGISTRAR - SIP registrar URI (e.g., sip.example.com:5060)
 *   TEST_USERNAME - SIP username
 *   TEST_PASSWORD - SIP password
 *   TEST_TRANSPORT - Transport protocol (udp, tcp, tls) - defaults to tls
 */

import readline from 'readline';
import dotenv from 'dotenv';
import https from 'https';
import http from 'http';

// Load environment variables from .env file
dotenv.config();

const API_KEY = process.env.API_KEY;
// SERVICE_BASE_URI is the base host (e.g., http://localhost:5000), we need to append /api
const SERVICE_BASE = process.env.SERVICE_BASE_URI || process.env.API_BASE_URL || 'http://localhost:4000';
const API_BASE_URL = SERVICE_BASE.endsWith('/api') ? SERVICE_BASE : `${SERVICE_BASE.replace(/\/$/, '')}/api`;

if (!API_KEY) {
  console.error('❌ Error: API_KEY environment variable is required');
  console.error('   Please set API_KEY in your .env file');
  process.exit(1);
}

// Helper to make HTTP requests
async function apiRequest(method, path, body = null) {
  // Construct full URL - if path starts with /, append it to base (which should already end with /api)
  // If base already ends with /api, path should start with /
  let fullUrl;
  if (path.startsWith('/')) {
    fullUrl = API_BASE_URL.endsWith('/') 
      ? `${API_BASE_URL.slice(0, -1)}${path}` 
      : `${API_BASE_URL}${path}`;
  } else {
    fullUrl = API_BASE_URL.endsWith('/') 
      ? `${API_BASE_URL}${path}` 
      : `${API_BASE_URL}/${path}`;
  }
  const url = new URL(fullUrl);
  
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }

    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.request(url, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        let parsedData;
        try {
          parsedData = data ? JSON.parse(data) : null;
        } catch (e) {
          parsedData = data;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: parsedData });
        } else {
          reject(new Error(`API request failed: ${res.statusCode} ${res.statusMessage}\n${JSON.stringify(parsedData, null, 2)}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request error: ${error.message}`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
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

// Helper to pause and wait for user input
function pause(message = 'Press Enter to continue with cleanup...') {
  return promptInput(`\n${message}\n`);
}

// Import test agent data
import aplisayTestAgentBase from './fixtures/aplisayTestAgentBase.js';

async function main() {
  let testAgentId;
  let testRegistrationId;
  let testListenerId;

  try {
    console.log('Using API:', API_BASE_URL);
    console.log('');

    // Step 1: Create agent using test data
    console.log('=== Step 1: Creating agent ===');
    // Transform functions array from test data format to API format
    const convertedFunctions = aplisayTestAgentBase.functions.map(func => {
      const properties = {};
      if (func.parameters) {
        func.parameters.forEach(param => {
          properties[param.name] = {
            type: param.type,
            source: param.source,
            from: param.from,
            description: param.description,
            in: param.in || 'query'
          };
        });
      }

      return {
        implementation: func.implementation,
        platform: func.platform,
        name: func.name,
        description: func.description,
        url: func.url,
        method: func.method,
        key: func.key,
        input_schema: {
          properties: properties
        }
      };
    });

    const agentData = {
      name: aplisayTestAgentBase.name,
      description: aplisayTestAgentBase.description,
      modelName: aplisayTestAgentBase.modelName,
      prompt: aplisayTestAgentBase.prompt.value,
      options: aplisayTestAgentBase.options,
      functions: convertedFunctions,
      keys: aplisayTestAgentBase.keys
    };

    const agentRes = await apiRequest('POST', '/agents', agentData);
    testAgentId = agentRes.body.id;
    console.log(`✓ Agent created with ID: ${testAgentId}`);

    // Step 2: Get registration endpoint details
    console.log('\n=== Step 2: Registration endpoint details ===');
    let registrar = process.env.TEST_REGISTRAR;
    let username = process.env.TEST_USERNAME;
    let password = process.env.TEST_PASSWORD;
    let transport = process.env.TEST_TRANSPORT || 'tls';

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
      console.log(`Using TEST_PASSWORD: ${'*'.repeat(password.length)}`);
    }

    console.log(`Using transport: ${transport}`);

    // Step 3: Create registration endpoint
    console.log('\n=== Step 3: Creating registration endpoint ===');
    const registrationData = {
      type: 'phone-registration',
      name: 'Manual Test Registration',
      handler: 'livekit',
      outbound: false,
      registrar: registrar,
      username: username,
      password: password,
      options: transport ? { transport } : undefined
    };

    const registrationRes = await apiRequest('POST', '/phone-endpoints', registrationData);
    testRegistrationId = registrationRes.body.id;
    console.log(`✓ Registration endpoint created with ID: ${testRegistrationId}`);

    // Step 4: Activate the endpoint
    console.log('\n=== Step 4: Activating registration endpoint ===');
    const activateRes = await apiRequest('POST', `/phone-endpoints/${testRegistrationId}/activate`);
    console.log(`✓ Registration endpoint activated`);
    console.log(`  Status: ${activateRes.body.status}`);
    console.log(`  State: ${activateRes.body.state}`);

    // Step 4a: Poll registration state until it becomes "registered"
    console.log('\n=== Step 4a: Waiting for registration to complete ===');
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

    // Step 5: Create listener
    console.log('\n=== Step 5: Creating listener ===');
    const listenerData = {
      id: testRegistrationId
    };

    const listenerRes = await apiRequest('POST', `/agents/${testAgentId}/listen`, listenerData);
    testListenerId = listenerRes.body.id;
    console.log(`✓ Listener created with ID: ${testListenerId}`);

    // Step 6: Pause for user input
    console.log('\n=== Step 6: Active session ===');
    console.log(`Agent ID: ${testAgentId}`);
    console.log(`Registration ID: ${testRegistrationId}`);
    console.log(`Listener ID: ${testListenerId}`);
    await pause('Session is active. Press Enter when ready to cleanup...');

    // Step 7: Cleanup
    console.log('\n=== Step 7: Cleanup ===');

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
