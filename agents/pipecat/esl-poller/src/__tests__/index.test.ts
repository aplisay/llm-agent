// Set env vars before importing the module (constants are evaluated at module load)
process.env.CONFIG_SERVER_BASE = process.env.CONFIG_SERVER_BASE || 'http://config-server:4000';
process.env.CONFIG_SERVER_TOKEN = process.env.CONFIG_SERVER_TOKEN || 'test-token';

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Mock dotenv and google-secret-helper before other imports
jest.mock('dotenv', () => ({
  config: jest.fn(),
}));

jest.mock('../google-secret-helper.js', () => ({}), { virtual: true });

// Create mock functions that will be shared
let mockGet: ReturnType<typeof jest.fn>;
let mockPost: ReturnType<typeof jest.fn>;

jest.mock('axios', () => {
  mockGet = jest.fn();
  mockPost = jest.fn();
  return {
    __esModule: true,
    default: {
      get: mockGet,
      post: mockPost,
    },
  };
});

import axios from 'axios';
import { FreeSwitchClient } from 'esl-lite';

// Get the mock functions - they're set in the mock factory above
mockGet = (axios as any).get;
mockPost = (axios as any).post;
import {
  mapFsStateToRegistration,
  parseSofiaStatusGateway,
  postGatewayState,
  markGatewayAsFailed,
  fetchActiveGatewayIds,
} from '../index.js';
import type { RegistrationState } from '../index.js';

// Mock pino logger
jest.mock('pino', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return jest.fn(() => mockLogger);
});

describe('ESL Poller - State Mapping', () => {
  describe('mapFsStateToRegistration', () => {
    test('should map registered states correctly', () => {
      expect(mapFsStateToRegistration('REGED')).toBe('registered');
      expect(mapFsStateToRegistration('UP')).toBe('registered');
      expect(mapFsStateToRegistration('ALIVE')).toBe('registered');
      expect(mapFsStateToRegistration('reged')).toBe('registered'); // case insensitive
      expect(mapFsStateToRegistration('up')).toBe('registered');
    });

    test('should map registering states correctly', () => {
      expect(mapFsStateToRegistration('TRYING')).toBe('registering');
      expect(mapFsStateToRegistration('PROBING')).toBe('registering');
      expect(mapFsStateToRegistration('REGISTER')).toBe('registering');
    });

    test('should map failed states correctly', () => {
      expect(mapFsStateToRegistration('NOREG')).toBe('failed');
      expect(mapFsStateToRegistration('UNREGED')).toBe('failed');
      expect(mapFsStateToRegistration('FAILED')).toBe('failed');
      expect(mapFsStateToRegistration('DOWN')).toBe('failed');
      expect(mapFsStateToRegistration('EXPIRED')).toBe('failed');
      expect(mapFsStateToRegistration('FAIL_WAIT')).toBe('failed');
    });

    test('should default to initial for unknown states', () => {
      expect(mapFsStateToRegistration('UNKNOWN')).toBe('initial');
      expect(mapFsStateToRegistration('')).toBe('initial');
      expect(mapFsStateToRegistration('XYZ')).toBe('initial');
    });

    test('should handle case insensitivity', () => {
      expect(mapFsStateToRegistration('failed')).toBe('failed');
      expect(mapFsStateToRegistration('Failed')).toBe('failed');
      expect(mapFsStateToRegistration('FAILED')).toBe('failed');
    });
  });

  describe('parseSofiaStatusGateway', () => {
    test('should parse valid gateway output', () => {
      const output = `Name                        Type  Data        State
external::gateway1          sofia gateway    REGED
external::gateway2          sofia gateway    FAILED
external::gateway3          sofia gateway    TRYING`;

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(3);
      expect(result.get('gateway1')).toBe('registered');
      expect(result.get('gateway2')).toBe('failed');
      expect(result.get('gateway3')).toBe('registering');
    });

    test('should parse profile header format with extra columns', () => {
      const output = `Profile::Gateway-Name                        Data        State   Ping Time   IB Calls(F/T)   OB Calls(F/T)
=================================================================================================
external::f3b9ba45-8498-4f3a-8a15-ead09c203b4f  sip:username@host.thing.com:5061;transport=tls  REGED    0.00  0/3  0/0
external::51681b4a-f2c5-49a2-864f-ea0697d5895e  sip:user@host;transport=tls                          FAIL_WAIT 0.00  0/0  0/0
`;

      const result = parseSofiaStatusGateway(output);
      expect(result.get('f3b9ba45-8498-4f3a-8a15-ead09c203b4f')).toBe('registered');
      expect(result.get('51681b4a-f2c5-49a2-864f-ea0697d5895e')).toBe('failed');
    });

    test('should strip external:: prefix', () => {
      const output = `external::test-gateway      sofia gateway    REGED`;

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(1);
      expect(result.has('external::test-gateway')).toBe(false);
      expect(result.has('test-gateway')).toBe(true);
    });

    test('should skip non-external gateways', () => {
      const output = `external::gateway1          sofia gateway    REGED
livekit::livekit            sofia gateway    REGED
internal::gateway2          sofia gateway    REGED`;

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(1);
      expect(result.has('gateway1')).toBe(true);
      expect(result.has('livekit')).toBe(false);
      expect(result.has('gateway2')).toBe(false);
    });

    test('should skip header lines', () => {
      const output = `Name                        Type  Data        State
--------------------------------------------------
external::gateway1          sofia gateway    REGED
Gateway                     Type  Data        State
external::gateway2          sofia gateway    FAILED`;

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(2);
    });

    test('should skip separator lines', () => {
      const output = `--------------------------------------------------
external::gateway1          sofia gateway    REGED
==========
external::gateway2          sofia gateway    FAILED`;

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(2);
    });

    test('should handle empty output', () => {
      const result = parseSofiaStatusGateway('');
      expect(result.size).toBe(0);
    });

    test('should handle lines with insufficient columns', () => {
      const output = `external::gateway1          REGED
external::gateway2          sofia gateway    REGED`;

      const result = parseSofiaStatusGateway(output);

      // Only gateway2 should be parsed (gateway1 has insufficient columns)
      expect(result.size).toBe(1);
      expect(result.has('gateway2')).toBe(true);
    });

    test('should skip livekit gateways even with external prefix', () => {
      const output = `external::livekit           sofia gateway    REGED
external::gateway1          sofia gateway    REGED`;

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(1);
      expect(result.has('livekit')).toBe(false);
      expect(result.has('gateway1')).toBe(true);
    });

    test('should handle Windows line endings', () => {
      const output = 'external::gateway1          sofia gateway    REGED\r\nexternal::gateway2          sofia gateway    FAILED\r\n';

      const result = parseSofiaStatusGateway(output);

      expect(result.size).toBe(2);
      expect(result.has('gateway1')).toBe(true);
      expect(result.has('gateway2')).toBe(true);
    });
  });
});

describe('ESL Poller - Config Server Integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    // Set env vars before each test - they're read at module load, so we need to reload
    // or ensure they're set. Since we can't easily reload, we'll set them globally
    process.env.CONFIG_SERVER_BASE = 'http://config-server:4000';
    process.env.CONFIG_SERVER_TOKEN = 'test-token';
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv.CONFIG_SERVER_BASE !== undefined) {
      process.env.CONFIG_SERVER_BASE = originalEnv.CONFIG_SERVER_BASE;
    } else {
      delete process.env.CONFIG_SERVER_BASE;
    }
    if (originalEnv.CONFIG_SERVER_TOKEN !== undefined) {
      process.env.CONFIG_SERVER_TOKEN = originalEnv.CONFIG_SERVER_TOKEN;
    } else {
      delete process.env.CONFIG_SERVER_TOKEN;
    }
  });

  describe('fetchActiveGatewayIds', () => {
    test('should fetch and return active gateway IDs', async () => {
      const expectedIds = ['gateway1', 'gateway2', 'gateway3'];
      mockGet.mockResolvedValueOnce({
        data: { ids: expectedIds },
      });

      const result = await fetchActiveGatewayIds();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('gateway1')).toBe(true);
      expect(result.has('gateway2')).toBe(true);
      expect(result.has('gateway3')).toBe(true);

      expect(mockGet).toHaveBeenCalledWith(
        'http://config-server:4000/admin/gateways/ids',
        {
          headers: { Authorization: 'Bearer test-token' },
          timeout: 5000,
        }
      );
    });

    test('should return empty set on error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchActiveGatewayIds();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    test('should handle missing ids in response', async () => {
      mockGet.mockResolvedValueOnce({
        data: {},
      });

      const result = await fetchActiveGatewayIds();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

  });

  describe('postGatewayState', () => {
    test('should post gateway state to config server', async () => {
      // Env vars are set in beforeEach
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      await postGatewayState('gateway1', 'registered');

      expect(mockPost).toHaveBeenCalledWith(
        'http://config-server:4000/admin/gateways/gateway1/status',
        { state: 'registered' },
        {
          headers: { Authorization: 'Bearer test-token' },
          timeout: 5000,
        }
      );
    });

    test('should handle URL encoding in gateway ID', async () => {
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      await postGatewayState('gateway with spaces', 'failed');

      expect(mockPost).toHaveBeenCalledWith(
        'http://config-server:4000/admin/gateways/gateway%20with%20spaces/status',
        { state: 'failed' },
        expect.any(Object)
      );
    });

    test('should handle errors gracefully', async () => {
      mockPost.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(postGatewayState('gateway1', 'registered')).resolves.not.toThrow();
    });

  });

  describe('markGatewayAsFailed', () => {
    test('should mark gateway as failed in config server', async () => {
      // Env vars are set in beforeEach
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      await markGatewayAsFailed('gateway1');

      expect(mockPost).toHaveBeenCalledWith(
        'http://config-server:4000/admin/gateways/gateway1/mark-failed',
        {},
        {
          headers: { Authorization: 'Bearer test-token' },
          timeout: 5000,
        }
      );
    });

    test('should handle URL encoding in gateway ID', async () => {
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      await markGatewayAsFailed('gateway-id-with-special-chars');

      expect(mockPost).toHaveBeenCalledWith(
        'http://config-server:4000/admin/gateways/gateway-id-with-special-chars/mark-failed',
        {},
        expect.any(Object)
      );
    });

    test('should handle errors gracefully', async () => {
      mockPost.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(markGatewayAsFailed('gateway1')).resolves.not.toThrow();
    });
  });
});
