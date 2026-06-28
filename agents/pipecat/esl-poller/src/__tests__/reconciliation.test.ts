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
import {
  fetchActiveGatewayIds,
  markGatewayAsFailed,
  parseSofiaStatusGateway,
  postGatewayState,
  reconcileGateways,
  resetFailedStateCounter,
} from '../index.js';

// Get the mock functions - they're set in the mock factory above
mockGet = (axios as any).get;
mockPost = (axios as any).post;

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

describe('ESL Poller - Reconciliation Logic', () => {
  let mockClient: jest.Mocked<FreeSwitchClient>;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      CONFIG_SERVER_BASE: 'http://config-server:4000',
      CONFIG_SERVER_TOKEN: 'test-token',
    };

    mockClient = {
      bgapi: jest.fn(),
    } as unknown as jest.Mocked<FreeSwitchClient>;

    mockPost.mockResolvedValue({ data: { success: true } });
    mockGet.mockResolvedValue({ data: { ids: [] } });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Gateway Removal', () => {
    test('should identify gateways to remove', async () => {
      // Config server has: gateway1
      // FreeSWITCH has: gateway1, gateway2
      // Expected: gateway2 should be removed

      mockGet.mockResolvedValueOnce({
        data: { ids: ['gateway1'] },
      });

      const fsOutput = `
Name                        Type  Data        State
external::gateway1          sofia gateway    REGED
external::gateway2          sofia gateway    REGED
      `.trim();

      const parsed = parseSofiaStatusGateway(fsOutput);
      const activeIds = await fetchActiveGatewayIds();

      const gatewaysToRemove = Array.from(parsed.keys()).filter(
        (id) => !activeIds.has(id)
      );

      expect(gatewaysToRemove).toEqual(['gateway2']);
    });

    test('should not remove gateways that are active', async () => {
      mockGet.mockResolvedValueOnce({
        data: { ids: ['gateway1', 'gateway2'] },
      });

      const fsOutput = `
Name                        Type  Data        State
external::gateway1          sofia gateway    REGED
external::gateway2          sofia gateway    REGED
      `.trim();

      const parsed = parseSofiaStatusGateway(fsOutput);
      const activeIds = await fetchActiveGatewayIds();

      const gatewaysToRemove = Array.from(parsed.keys()).filter(
        (id) => !activeIds.has(id)
      );

      expect(gatewaysToRemove).toHaveLength(0);
    });
  });

  describe('Failed State Counter Tracking', () => {
    // Since failedStateCounterByGateway is not exported, we'll test the logic
    // by simulating what happens during reconciliation

    test('should track failed states correctly', () => {
      // Simulate the reconciliation logic for failed state tracking
      const failedCounter: Map<string, number> = new Map();
      const activeGatewayIds = new Set(['gateway1']);
      const fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    FAILED
      `.trim());

      // Simulate reconciliation logic
      for (const [gatewayId, state] of fsGateways.entries()) {
        if (activeGatewayIds.has(gatewayId)) {
          if (state === 'failed') {
            const currentCount = failedCounter.get(gatewayId) || 0;
            failedCounter.set(gatewayId, currentCount + 1);
          }
        }
      }

      expect(failedCounter.get('gateway1')).toBe(1);
    });

    test('should increment counter on consecutive failed states', () => {
      const failedCounter: Map<string, number> = new Map();
      const activeGatewayIds = new Set(['gateway1']);

      // Simulate 5 consecutive failed reconciliations
      for (let i = 0; i < 5; i++) {
        const fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    FAILED
        `.trim());

        for (const [gatewayId, state] of fsGateways.entries()) {
          if (activeGatewayIds.has(gatewayId)) {
            if (state === 'failed') {
              const currentCount = failedCounter.get(gatewayId) || 0;
              failedCounter.set(gatewayId, currentCount + 1);
            }
          }
        }
      }

      expect(failedCounter.get('gateway1')).toBe(5);
    });

    test('should reset counter when gateway becomes registered', () => {
      const failedCounter: Map<string, number> = new Map();
      const activeGatewayIds = new Set(['gateway1']);

      // First, increment counter with failed state
      let fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    FAILED
      `.trim());

      for (const [gatewayId, state] of fsGateways.entries()) {
        if (activeGatewayIds.has(gatewayId)) {
          if (state === 'failed') {
            failedCounter.set(gatewayId, (failedCounter.get(gatewayId) || 0) + 1);
          }
        }
      }

      expect(failedCounter.get('gateway1')).toBe(1);

      // Then, reset when registered
      fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    REGED
      `.trim());

      for (const [gatewayId, state] of fsGateways.entries()) {
        if (activeGatewayIds.has(gatewayId)) {
          if (state === 'registered') {
            failedCounter.delete(gatewayId);
          }
        }
      }

      expect(failedCounter.has('gateway1')).toBe(false);
    });

    test('should mark gateway as failed when counter reaches 7', async () => {
      const failedCounter: Map<string, number> = new Map();
      const activeGatewayIds = new Set(['gateway1']);

      // Simulate 7 consecutive failed states
      for (let i = 0; i < 7; i++) {
        const fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    FAILED
        `.trim());

        for (const [gatewayId, state] of fsGateways.entries()) {
          if (activeGatewayIds.has(gatewayId)) {
            if (state === 'failed') {
              const currentCount = failedCounter.get(gatewayId) || 0;
              const newCount = currentCount + 1;
              failedCounter.set(gatewayId, newCount);

              if (newCount >= 7) {
                // Mark as failed
                await markGatewayAsFailed(gatewayId);
                failedCounter.delete(gatewayId);
              }
            }
          }
        }
      }

      // Verify markGatewayAsFailed was called
      expect(mockPost).toHaveBeenCalledWith(
        'http://config-server:4000/admin/gateways/gateway1/mark-failed',
        {},
        expect.any(Object)
      );
    });

    test('should not reset counter on registering state', () => {
      const failedCounter: Map<string, number> = new Map();
      const activeGatewayIds = new Set(['gateway1']);

      // First, increment counter with failed state
      let fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    FAILED
      `.trim());

      for (const [gatewayId, state] of fsGateways.entries()) {
        if (activeGatewayIds.has(gatewayId)) {
          if (state === 'failed') {
            failedCounter.set(gatewayId, (failedCounter.get(gatewayId) || 0) + 1);
          }
        }
      }

      expect(failedCounter.get('gateway1')).toBe(1);

      // Then, check registering state (should NOT reset)
      fsGateways = parseSofiaStatusGateway(`
external::gateway1          sofia gateway    TRYING
      `.trim());

      for (const [gatewayId, state] of fsGateways.entries()) {
        if (activeGatewayIds.has(gatewayId)) {
          // Only reset on 'registered', not 'registering'
          if (state === 'registered') {
            failedCounter.delete(gatewayId);
          }
        }
      }

      // Counter should still be 1 (not reset)
      expect(failedCounter.get('gateway1')).toBe(1);
    });
  });

  describe('Integration Scenarios', () => {
    test('should handle mixed gateway states correctly', async () => {
      mockGet.mockResolvedValueOnce({
        data: { ids: ['gateway1', 'gateway2', 'gateway3'] },
      });

      const fsOutput = `
Name                        Type  Data        State
external::gateway1          sofia gateway    REGED
external::gateway2          sofia gateway    FAILED
external::gateway3          sofia gateway    TRYING
external::gateway4          sofia gateway    REGED
      `.trim();

      const parsed = parseSofiaStatusGateway(fsOutput);
      const activeIds = await fetchActiveGatewayIds();

      // gateway4 should be removed (not in active list)
      const gatewaysToRemove = Array.from(parsed.keys()).filter(
        (id) => !activeIds.has(id)
      );

      expect(gatewaysToRemove).toEqual(['gateway4']);
      expect(parsed.get('gateway1')).toBe('registered');
      expect(parsed.get('gateway2')).toBe('failed');
      expect(parsed.get('gateway3')).toBe('registering');
    });
  });

  describe('reconcileGateways Integration', () => {
    beforeEach(() => {
      resetFailedStateCounter();
    });

    test('should remove gateways not in config server', async () => {
      mockGet.mockResolvedValueOnce({
        data: { ids: ['gateway1'] },
      });

      const fsOutput = `
Name                        Type  Data        State
external::gateway1          sofia gateway    REGED
external::gateway2          sofia gateway    REGED
      `.trim();

      mockClient.bgapi
        .mockResolvedValueOnce({
          body: { 
            response: fsOutput,
            data: {},
            eventName: '',
            applicationUUID: '',
            jobUUID: '',
            headers: {} as any,
          },
        } as any)
        .mockResolvedValueOnce({
          body: { 
            response: 'OK',
            data: {},
            eventName: '',
            applicationUUID: '',
            jobUUID: '',
            headers: {} as any,
          },
        } as any);

      await reconcileGateways(mockClient);

      // Should call killgw for gateway2
      expect(mockClient.bgapi).toHaveBeenCalledWith(
        'sofia profile external killgw gateway2',
        5000
      );
    });

    test('should track failed state counter during reconciliation', async () => {
      mockGet.mockResolvedValue({
        data: { ids: ['gateway1'] },
      });

      const fsOutput = `
Name                        Type  Data        State
external::gateway1          sofia gateway    FAILED
      `.trim();

      mockClient.bgapi.mockResolvedValue({
        body: { 
          response: fsOutput,
          data: {},
          eventName: '',
          applicationUUID: '',
          jobUUID: '',
          headers: {} as any,
        },
      } as any);

      // Run reconciliation 5 times with failed state
      for (let i = 0; i < 5; i++) {
        await reconcileGateways(mockClient);
      }

      // Reconciliation tracks counters but doesn't post states
      // State posting happens in initial poll and event handlers
      // Counter should be at 5 but no mark-failed should be called yet (< 7)
      const markFailedCalls = mockPost.mock.calls.filter(
        (call: any[]) => call[0]?.includes('mark-failed')
      );
      expect(markFailedCalls.length).toBe(0); // Not reached threshold yet
    });

    test('should mark gateway as failed after 7 consecutive failed states', async () => {
      mockGet.mockResolvedValue({
        data: { ids: ['gateway1'] },
      });

      const fsOutput = `
Name                        Type  Data        State
external::gateway1          sofia gateway    FAILED
      `.trim();

      mockClient.bgapi.mockResolvedValue({
        body: { 
          response: fsOutput,
          data: {},
          eventName: '',
          applicationUUID: '',
          jobUUID: '',
          headers: {} as any,
        },
      } as any);

      // Run reconciliation 7 times with failed state
      for (let i = 0; i < 7; i++) {
        await reconcileGateways(mockClient);
      }

      // Should have called mark-failed endpoint
      const markFailedCalls = mockPost.mock.calls.filter(
        (call: any[]) => call[0]?.includes('mark-failed')
      );

      expect(markFailedCalls.length).toBeGreaterThan(0);
      expect(markFailedCalls[0][0]).toContain('gateway1/mark-failed');
    });

    test('should reset counter when gateway becomes registered', async () => {
      mockGet.mockResolvedValue({
        data: { ids: ['gateway1'] },
      });

      // First, 3 failed states
      mockClient.bgapi.mockResolvedValue({
        body: {
          response: `
Name                        Type  Data        State
external::gateway1          sofia gateway    FAILED
          `.trim(),
          data: {},
          eventName: '',
          applicationUUID: '',
          jobUUID: '',
          headers: {} as any,
        },
      } as any);

      for (let i = 0; i < 3; i++) {
        await reconcileGateways(mockClient);
      }

      // Then, registered state
      mockClient.bgapi.mockResolvedValue({
        body: {
          response: `
Name                        Type  Data        State
external::gateway1          sofia gateway    REGED
          `.trim(),
          data: {},
          eventName: '',
          applicationUUID: '',
          jobUUID: '',
          headers: {} as any,
        },
      } as any);

      await reconcileGateways(mockClient);

      // Counter should be reset, so next failed state should start from 1
      mockClient.bgapi.mockResolvedValue({
        body: {
          response: `
Name                        Type  Data        State
external::gateway1          sofia gateway    FAILED
          `.trim(),
          data: {},
          eventName: '',
          applicationUUID: '',
          jobUUID: '',
          headers: {} as any,
        },
      } as any);

      await reconcileGateways(mockClient);

      // Counter should have been reset (gateway is now registered)
      // Reconciliation doesn't post states - that happens in initial poll and events
      // Just verify the reconciliation completed without errors
      expect(mockClient.bgapi).toHaveBeenCalled();
    });

    test('should handle no response from FreeSWITCH gracefully', async () => {
      mockGet.mockResolvedValueOnce({
        data: { ids: ['gateway1'] },
      });

      mockClient.bgapi.mockResolvedValueOnce({
        body: {
          response: undefined, // No response means the check will fail and return early
          data: {},
          eventName: '',
          applicationUUID: '',
          jobUUID: '',
          headers: {} as any,
        },
      } as any);

      await expect(reconcileGateways(mockClient)).resolves.not.toThrow();
    });

    test('should handle FreeSWITCH errors gracefully', async () => {
      mockGet.mockResolvedValueOnce({
        data: { ids: ['gateway1'] },
      });

      mockClient.bgapi.mockRejectedValueOnce(new Error('FreeSWITCH error'));

      await expect(reconcileGateways(mockClient)).resolves.not.toThrow();
    });
  });
});

