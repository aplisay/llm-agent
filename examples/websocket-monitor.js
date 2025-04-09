require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');

// Base URL for the API
const API_BASE_URL = 'http://localhost:5000/api';

// Create an axios instance with default config
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.API_KEY}`
  }
});

/**
 * Get available models from the API
 */
async function getModels() {
  try {
    const response = await api.get('/models');
    console.log('Available models:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error getting models:', error.message);
    throw error;
  }
}

/**
 * Create a new agent
 * @param {string} modelName - The model to use (e.g., 'gpt35')
 * @param {string} prompt - The prompt for the agent
 * @param {object} options - Additional options for the agent
 */
async function createAgent(modelName, prompt, options = {}) {
  try {
    const agentData = {
      modelName,
      prompt,
      options: {
        temperature: 0.7,
        tts: {
          language: 'en-US',
          voice: 'en-US-Wavenet-A'
        },
        stt: {
          language: 'en-US'
        },
        ...options
      }
    };

    const response = await api.post('/agents', agentData);
    console.log('Agent created:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error creating agent:', error.message);
    throw error;
  }
}

/**
 * Activate an agent to listen for calls or WebRTC connections
 * @param {string} agentId - The ID of the agent to activate
 * @param {object} options - Activation options
 */
async function activateAgent(agentId, options = {}) {
  try {
    const activationData = {
      websocket: true, // Use WebRTC/websocket instead of phone number
      options: {
        streamLog: true, // Enable debug transcript
        ...options
      }
    };

    const response = await api.post(`/agents/${agentId}/listen`, activationData);
    console.log('Agent activated:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error activating agent:', error.message);
    throw error;
  }
}

/**
 * Get join information for a room
 * @param {string} listenerId - The ID of the listener
 * @param {object} options - Join options
 */
async function joinRoom(listenerId, options = {}) {
  try {
    const joinData = {
      options: {
        streamLog: true,
        ...options
      }
    };

    const response = await api.post(`/rooms/${listenerId}/join`, joinData);
    console.log('Room join info:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error joining room:', error.message);
    throw error;
  }
}

/**
 * Delete a listener
 * @param {string} agentId - The ID of the agent
 * @param {string} listenerId - The ID of the listener to delete
 */
async function deleteListener(agentId, listenerId) {
  try {
    const response = await api.delete(`/agents/${agentId}/listen/${listenerId}`);
    console.log('Listener deleted');
    return response.data;
  } catch (error) {
    console.error('Error deleting listener:', error.message);
    throw error;
  }
}

/**
 * Delete an agent
 * @param {string} agentId - The ID of the agent to delete
 */
async function deleteAgent(agentId) {
  try {
    const response = await api.delete(`/agents/${agentId}`);
    console.log('Agent deleted');
    return response.data;
  } catch (error) {
    console.error('Error deleting agent:', error.message);
    throw error;
  }
}

/**
 * Connect to the progress WebSocket
 * @param {string} socketUrl - The WebSocket URL
 * @returns {Promise<WebSocket>} - The WebSocket connection
 */
function connectToProgressSocket(socketUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl);
    
    ws.on('open', () => {
      console.log('Connected to progress WebSocket');
      resolve(ws);
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        handleProgressMessage(message);
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      reject(error);
    });
    
    ws.on('close', () => {
      console.log('WebSocket connection closed');
    });
  });
}

/**
 * Handle progress messages from the WebSocket
 * @param {object} message - The progress message
 */
function handleProgressMessage(message) {
  // Extract the message type and data
  const messageType = Object.keys(message)[0];
  const messageData = message[messageType];
  
  switch (messageType) {
    case 'user':
      console.log('User said:', messageData.user);
      break;
    case 'agent':
      console.log('Agent responded:', messageData.agent);
      break;
    case 'call':
      console.log('Call from:', messageData.call);
      break;
    case 'hangup':
      console.log('Call ended');
      break;
    case 'data':
      console.log('Data received:', messageData.data);
      break;
    case 'inject':
      console.log('Injected message:', messageData.inject);
      break;
    default:
      console.log('Unknown message type:', messageType, messageData);
  }
}

/**
 * Main function to demonstrate the API usage with WebSocket monitoring
 */
async function main() {
  let ws = null;
  let agentId = null;
  let listenerId = null;
  
  try {
    // Step 1: Get available models
    const models = await getModels();
    
    // Step 2: Create an agent
    const modelName = Object.keys(models)[0]; // Use the first available model
    const prompt = `You are a helpful AI assistant. You can help users with various tasks.
    Be concise and friendly in your responses.`;
    
    const agent = await createAgent(modelName, prompt);
    agentId = agent.id;
    
    // Step 3: Activate the agent
    const activation = await activateAgent(agentId);
    listenerId = activation.id;
    
    // Step 4: Get room join information
    const roomInfo = await joinRoom(listenerId);
    
    console.log('Agent is ready!');
    console.log('To connect to the agent:');
    console.log('- WebRTC URL:', roomInfo.livekit?.url || roomInfo.ultravox?.joinUrl);
    console.log('- Token:', roomInfo.livekit?.token);
    
    // Step 5: Connect to the progress WebSocket if available
    if (activation.socket) {
      console.log('Connecting to progress WebSocket:', activation.socket);
      ws = await connectToProgressSocket(activation.socket);
    } else {
      console.log('No progress WebSocket available');
    }
    
    // Keep the agent running for a while
    console.log('Agent will run for 120 seconds...');
    await new Promise(resolve => setTimeout(resolve, 120000));
    
    // Step 6: Clean up
    if (ws) {
      ws.close();
    }
    
    if (listenerId) {
      await deleteListener(agentId, listenerId);
    }
    
    if (agentId) {
      await deleteAgent(agentId);
    }
    
    console.log('Demo completed successfully!');
  } catch (error) {
    console.error('Error in main function:', error.message);
    
    // Clean up on error
    if (ws) {
      ws.close();
    }
    
    if (listenerId && agentId) {
      try {
        await deleteListener(agentId, listenerId);
      } catch (e) {
        console.error('Error cleaning up listener:', e.message);
      }
    }
    
    if (agentId) {
      try {
        await deleteAgent(agentId);
      } catch (e) {
        console.error('Error cleaning up agent:', e.message);
      }
    }
  }
}

// Run the main function
main(); 