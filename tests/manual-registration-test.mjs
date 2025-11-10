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
 *                        Options: test-agent-base, blind-transfer-agent
 */

import readline from 'readline';
import dotenv from 'dotenv';
import axios from 'axios';

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

// Helper to pause and wait for user input
function pause(message = 'Press Enter to continue with cleanup...') {
  return promptInput(`\n${message}\n`);
}

// Available agent fixtures
const AGENT_FIXTURES = {
  'test-agent-base': './fixtures/agents/test-agent-base.js',
  'blind-transfer-agent': './fixtures/agents/blind-transfer-agent.js'
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
    // Transform functions array from test data format to API format
    const convertedFunctions = (selectedAgent.functions || []).map(func => {
      // Handle both formats: functions with parameters or with input_schema already defined
      let input_schema;
      if (func.input_schema) {
        // Already in API format
        input_schema = func.input_schema;
      } else if (func.parameters) {
        // Convert from parameters format
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
        input_schema = { properties };
      } else {
        input_schema = { properties: {} };
      }

      return {
        implementation: func.implementation,
        platform: func.platform,
        name: func.name,
        description: func.description,
        url: func.url,
        method: func.method,
        key: func.key,
        input_schema: input_schema
      };
    });

    // Handle both prompt formats: object with value property or string
    const promptValue = typeof selectedAgent.prompt === 'string' 
      ? selectedAgent.prompt 
      : (selectedAgent.prompt?.value || '');

    const agentData = {
      name: selectedAgent.name,
      description: selectedAgent.description,
      modelName: selectedAgent.modelName,
      prompt: promptValue,
      options: selectedAgent.options || {},
      functions: convertedFunctions,
      keys: selectedAgent.keys || []
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
      options: transport ? { transport } : undefined
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
          const updateData = {
            password: password,
            options: transport ? { transport } : undefined
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
      id: testRegistrationId
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

    // Step 7: Pause for user input
    console.log('\n=== Step 7: Active session ===');
    console.log(`Agent ID: ${testAgentId}`);
    console.log(`Registration ID: ${testRegistrationId}`);
    console.log(`Listener ID: ${testListenerId}`);
    await pause('Session is active. Press Enter when ready to cleanup...');

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
