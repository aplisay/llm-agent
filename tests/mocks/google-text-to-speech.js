// Every jest config maps `@google-cloud/text-to-speech` to this file, so no
// test opens a gRPC channel to Google or looks for Google credentials.
// lib/voices/google.js only lists voices. A method that is not here has no
// stand-in yet.
import { googleTextToSpeechVoices } from '../fixtures/vendor-catalogues.js';

export class TextToSpeechClient {
  async listVoices() {
    return [{ voices: structuredClone(googleTextToSpeechVoices) }, null, null];
  }
}
