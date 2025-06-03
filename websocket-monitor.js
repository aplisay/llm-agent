require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Room, RoomEvent, RemoteParticipant, RemoteTrackPublication, RemoteTrack } = require('livekit-client');

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

// Create a temporary directory for audio files
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// LiveKit room instance
let room = null;

/**
 * Connect to LiveKit room
 * @param {string} url - LiveKit room URL
 * @param {string} token - LiveKit token
 */
async function connectToLiveKit(url, token) {
  room = new Room();
  
  // Set up event handlers
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    console.log(`Track subscribed: ${track.kind} from ${participant.identity}`);
    
    if (track.kind === 'audio') {
      // Handle audio track
      const audioTrack = track;
      console.log('Audio track received');
      
      // Set up audio playback
      audioTrack.on('data', (data) => {
        console.log(`Received audio data: ${data.length} bytes`);
        playAudio(data);
      });
    }
  });
  
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`Participant connected: ${participant.identity}`);
  });
  
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    console.log(`Participant disconnected: ${participant.identity}`);
  });
  
  // Connect to the room
  try {
    await room.connect(url, token);
    console.log('Connected to LiveKit room');
  } catch (error) {
    console.error('Error connecting to LiveKit room:', error);
  }
}

/**
 * Create WAV header for audio data
 * @param {number} sampleRate - Sample rate in Hz
 * @param {number} bitsPerSample - Bits per sample
 * @param {number} channels - Number of channels
 * @param {number} dataLength - Length of audio data
 * @returns {Buffer} - WAV header
 */
function createWavHeader(sampleRate = 16000, bitsPerSample = 16, channels = 1, dataLength) {
  const buffer = Buffer.alloc(44);
  
  // RIFF identifier
  buffer.write('RIFF', 0);
  // File length
  buffer.writeUInt32LE(dataLength + 36, 4);
  // WAVE identifier
  buffer.write('WAVE', 8);
  // Format chunk marker
  buffer.write('fmt ', 12);
  // Length of format data
  buffer.writeUInt32LE(16, 16);
  // Format type (1 = PCM)
  buffer.writeUInt16LE(1, 20);
  // Number of channels
  buffer.writeUInt16LE(channels, 22);
  // Sample rate
  buffer.writeUInt32LE(sampleRate, 24);
  // Byte rate
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  // Block align
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32);
  // Bits per sample
  buffer.writeUInt16LE(bitsPerSample, 34);
  // Data chunk marker
  buffer.write('data', 36);
  // Data length
  buffer.writeUInt32LE(dataLength, 40);
  
  return buffer;
}

/**
 * Play audio data through the host speakers
 * @param {Buffer} audioData - The audio data to play
 */
function playAudio(audioData) {
  // Generate a unique filename for this audio chunk
  const filename = path.join(tempDir, `audio_${Date.now()}.wav`);
  
  // Create WAV header
  const header = createWavHeader(16000, 16, 1, audioData.length);
  
  // Write the WAV file with header and audio data
  const wavFile = Buffer.concat([header, audioData]);
  fs.writeFileSync(filename, wavFile);
  
  // Play the audio file using the appropriate command for the OS
  let command;
  if (process.platform === 'darwin') {
    // macOS
    command = `afplay "${filename}"`;
  } else if (process.platform === 'win32') {
    // Windows
    command = `start /min wmplayer "${filename}"`;
  } else {
    // Linux and others
    command = `aplay "${filename}"`;
  }
  
  exec(command, (error) => {
    if (error) {
      console.error(`Error playing audio: ${error.message}`);
    }
    
    // Clean up the temporary file after a delay
    setTimeout(() => {
      try {
        fs.unlinkSync(filename);
      } catch (e) {
        // Ignore errors if file is already deleted
      }
    }, 1000);
  });
}

/**
 * Connect to the audio WebSocket
 * @param {string} socketUrl - The WebSocket URL
 * @returns {Promise<WebSocket>} - The WebSocket connection
 */
function connectToAudioSocket(socketUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl);
    
    ws.on('open', () => {
      console.log('Connected to audio WebSocket');
      resolve(ws);
    });
    
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          // Handle binary audio data directly
          console.log(`Received binary audio data: ${data.length} bytes`);
          playAudio(data);
        } else {
          // Handle text messages (JSON)
          const message = JSON.parse(data.toString());
          console.log('Received text message:', message);
          
          if (message.type === 'room_info') {
            // Connect to LiveKit room
            console.log('Connecting to LiveKit room...');
            connectToLiveKit(message.roomUrl, message.token);
          } else if (message.type === 'text') {
            console.log('Text content:', message.text);
          }
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    });
    
    ws.on('error', (error) => {
      console.error('Audio WebSocket error:', error);
      reject(error);
    });
    
    ws.on('close', () => {
      console.log('Audio WebSocket connection closed');
    });
  });
}

/**
 * Main function to demonstrate the API usage with audio WebSocket
 */
async function main() {
  let audioWs = null;
  let agentId = null;
  let listenerId = null;
  
  try {
    // ... existing code ...
    
    // Step 6: Clean up
    if (audioWs) {
      audioWs.close();
    }
    
    if (room) {
      await room.disconnect();
    }
    
    if (listenerId) {
      await deleteListener(agentId, listenerId);
    }
    
    if (agentId) {
      await deleteAgent(agentId);
    }
    
    // ... rest of the existing code ...
  } catch (error) {
    // ... existing error handling ...
    
    // Clean up LiveKit room
    if (room) {
      try {
        await room.disconnect();
      } catch (e) {
        console.error('Error disconnecting from LiveKit room:', e.message);
      }
    }
    
    // ... rest of the existing error handling ...
  }
}

// Run the main function
main(); 