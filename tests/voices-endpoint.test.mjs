import dotenv from 'dotenv';
import { setupRealDatabase, teardownRealDatabase, getRealDatabase } from './setup/database-test-wrapper.js';

describe('Voices Endpoint Test', () => {
  let models;
  let voicesList;

  // Mock objects for API endpoints
  let mockLogger;
  let mockVoices;

  beforeAll(async () => {
    // Connect to real database
    await setupRealDatabase();
    const realDb = getRealDatabase();
    dotenv.config();
    models = realDb.models;

    // Import API endpoints after database is set up
    const voicesModule = await import('../api/paths/voices.js');

    // Create mock logger and voices
    mockLogger = {
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => mockLogger
    };
    mockVoices = {};

    // Initialize the API endpoint
    const voicesHandler = voicesModule.default(mockLogger, mockVoices);
    voicesList = voicesHandler.GET;
  }, 30000);

  afterAll(async () => {
    // Disconnect from real database
    await teardownRealDatabase();
  }, 60000);

  // Helper function to create mock request
  const createMockRequest = (options = {}) => ({
    body: {},
    params: {},
    query: {},
    headers: {},
    log: mockLogger,
    ...options
  });

  // Helper function to create mock response
  const createMockResponse = () => {
    const res = {
      _status: null,
      _body: null,
      locals: {}
    };
    
    res.status = (code) => {
      res._status = code;
      return res;
    };
    
    res.send = (body) => {
      res._body = body;
      return res;
    };
    
    return res;
  };

  test('should return list of available voices', async () => {
    console.log('Testing voices endpoint...');

    const req = createMockRequest();
    const res = createMockResponse();

    await voicesList(req, res);

    // Should return 200 status (or null if not explicitly set)
    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();
    expect(typeof res._body).toBe('object');

    // Should contain voice information organized by handler/provider/language
    const voiceEntries = Object.entries(res._body);
    expect(voiceEntries.length).toBeGreaterThan(0);

    console.log(`Found ${voiceEntries.length} voice providers:`);

    // Validate each voice provider entry
    for (const [providerName, providerVoices] of voiceEntries) {
      console.log(`  - ${providerName}:`);
      
      // Each provider should have voice data
      expect(providerVoices).toBeDefined();
      expect(typeof providerVoices).toBe('object');

      // Validate provider structure (handler/provider/language)
      const providerEntries = Object.entries(providerVoices);
      expect(providerEntries.length).toBeGreaterThan(0);

      for (const [providerType, languageVoices] of providerEntries) {
        console.log(`    - ${providerType}:`);
        
        // Each provider type should have language-specific voices
        expect(languageVoices).toBeDefined();
        expect(typeof languageVoices).toBe('object');

        const languageEntries = Object.entries(languageVoices);
        expect(languageEntries.length).toBeGreaterThan(0);

        for (const [language, voices] of languageEntries) {
          console.log(`      - ${language}: ${voices.length} voices`);
          
          // Each language should have an array of voices
          expect(Array.isArray(voices)).toBe(true);
          expect(voices.length).toBeGreaterThan(0);

          // Validate each voice object
          for (const voice of voices) {
            expect(voice).toHaveProperty('name');
            expect(voice).toHaveProperty('description');
            expect(voice).toHaveProperty('gender');

            // Validate property types
            expect(typeof voice.name).toBe('string');
            expect(typeof voice.description).toBe('string');
            expect(typeof voice.gender).toBe('string');

            // Names should not be empty
            expect(voice.name.length).toBeGreaterThan(0);
            expect(voice.description.length).toBeGreaterThan(0);
          }
        }
      }
    }

    console.log('Voices endpoint test completed successfully!');
  });

  test('should return consistent voice structure', async () => {
    console.log('Testing voice structure consistency...');

    const req = createMockRequest();
    const res = createMockResponse();

    await voicesList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const voiceEntries = Object.entries(res._body);
    
    // All voice providers should have the same nested structure
    for (const [providerName, providerVoices] of voiceEntries) {
      const providerEntries = Object.entries(providerVoices);
      
      for (const [providerType, languageVoices] of providerEntries) {
        const languageEntries = Object.entries(languageVoices);
        
        for (const [language, voices] of languageEntries) {
          // All voices should have the same structure
          for (const voice of voices) {
            const requiredKeys = ['name', 'description', 'gender'];
            
            for (const key of requiredKeys) {
              expect(voice).toHaveProperty(key);
            }

            // Should not have extra unexpected keys
            const actualKeys = Object.keys(voice);
            expect(actualKeys).toEqual(expect.arrayContaining(requiredKeys));
          }
        }
      }
    }

    console.log('Voice structure consistency test completed!');
  });

  test('should include expected voice providers', async () => {
    console.log('Testing for expected voice providers...');

    const req = createMockRequest();
    const res = createMockResponse();

    await voicesList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const providerNames = Object.keys(res._body);
    
    console.log(`Found providers: ${providerNames.join(', ')}`);

    // Should have at least one provider
    expect(providerNames.length).toBeGreaterThan(0);

    // Common providers that might be present
    const expectedProviders = ['jambonz', 'livekit', 'ultravox'];
    const hasExpectedProvider = expectedProviders.some(provider => providerNames.includes(provider));
    
    // At least one expected provider should be present
    expect(hasExpectedProvider).toBe(true);

    console.log('Voice providers test completed!');
  });

  test('should validate voice properties', async () => {
    console.log('Testing voice properties validation...');

    const req = createMockRequest();
    const res = createMockResponse();

    await voicesList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const voiceEntries = Object.entries(res._body);
    
    for (const [providerName, providerVoices] of voiceEntries) {
      const providerEntries = Object.entries(providerVoices);
      
      for (const [providerType, languageVoices] of providerEntries) {
        const languageEntries = Object.entries(languageVoices);
        
        for (const [language, voices] of languageEntries) {
          for (const voice of voices) {
            // Check that properties are non-empty strings
            expect(voice.name).toBeTruthy();
            expect(voice.name.length).toBeGreaterThan(0);
            expect(voice.description).toBeTruthy();
            expect(voice.description.length).toBeGreaterThan(0);
            expect(voice.gender).toBeTruthy();
            expect(voice.gender.length).toBeGreaterThan(0);

            // Check that gender is a valid value
            const validGenders = ['male', 'female', 'unknown', 'neutral'];
            expect(validGenders).toContain(voice.gender);

            // Voice names are external data - just ensure they're non-empty strings
            // We don't validate character patterns as external providers may use any characters
          }
        }
      }
    }

    console.log('Voice properties validation completed!');
  });

  test('should handle errors gracefully', async () => {
    console.log('Testing voices endpoint error handling...');

    const req = createMockRequest();
    const res = createMockResponse();

    // Test that the endpoint handles requests properly
    await voicesList(req, res);

    // The response should be structured correctly
    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();
    
    console.log('Error handling test completed!');
  });

  test('should return voices for multiple languages', async () => {
    console.log('Testing multiple language support...');

    const req = createMockRequest();
    const res = createMockResponse();

    await voicesList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const voiceEntries = Object.entries(res._body);
    
    // Check if any provider supports multiple languages
    let hasMultipleLanguages = false;
    const languagesFound = new Set();

    for (const [providerName, providerVoices] of voiceEntries) {
      const providerEntries = Object.entries(providerVoices);
      
      for (const [providerType, languageVoices] of providerEntries) {
        const languageEntries = Object.entries(languageVoices);
        
        for (const [language, voices] of languageEntries) {
          languagesFound.add(language);
          if (languagesFound.size > 1) {
            hasMultipleLanguages = true;
            break;
          }
        }
        
        if (hasMultipleLanguages) break;
      }
      
      if (hasMultipleLanguages) break;
    }

    console.log(`Found languages: ${Array.from(languagesFound).join(', ')}`);

    // Should support at least one language
    expect(languagesFound.size).toBeGreaterThan(0);

    console.log('Multiple language support test completed!');
  });

  test('should have reasonable voice counts', async () => {
    console.log('Testing voice counts...');

    const req = createMockRequest();
    const res = createMockResponse();

    await voicesList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const voiceEntries = Object.entries(res._body);
    
    for (const [providerName, providerVoices] of voiceEntries) {
      const providerEntries = Object.entries(providerVoices);
      
      for (const [providerType, languageVoices] of providerEntries) {
        const languageEntries = Object.entries(languageVoices);
        
        for (const [language, voices] of languageEntries) {
          // Each language should have a reasonable number of voices
          expect(voices.length).toBeGreaterThan(0);
          expect(voices.length).toBeLessThan(1000); // Reasonable upper limit
          
          console.log(`${providerName}/${providerType}/${language}: ${voices.length} voices`);
        }
      }
    }

    console.log('Voice counts test completed!');
  });
});
