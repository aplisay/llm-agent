import { resolveCallHook, buildCallHookPayload, signCallHookPayload } from '../lib/call-hook.js';

describe('call-hook helper', () => {
  test('resolveCallHook prefers instance metadata over agent options', () => {
    const agent = {
      id: 'agent-1',
      options: {
        callHook: {
          url: 'https://example.com/agent',
          hashKey: 'agent-secret',
          includeTranscript: false,
          events: ['start']
        }
      }
    };

    const instance = {
      id: 'instance-1',
      metadata: {
        callHook: {
          url: 'https://example.com/instance',
          hashKey: 'instance-secret',
          includeTranscript: true,
          events: ['end']
        }
      }
    };

    const hook = resolveCallHook({ agent, listenerOrInstance: instance });

    expect(hook).toBeDefined();
    expect(hook.url).toBe('https://example.com/instance');
    expect(hook.hashKey).toBe('instance-secret');
    expect(hook.includeTranscript).toBe(true);
    expect(hook.events).toEqual(['end']);
  });

  test('buildCallHookPayload builds minimal start payload', () => {
    const call = {
      id: 'call-1',
      agentId: 'agent-1',
      instanceId: 'inst-1',
      callerId: '+1000',
      calledId: '+2000'
    };

    const payload = buildCallHookPayload({
      event: 'start',
      call,
      agent: null,
      listenerOrInstance: null
    });

    expect(payload.event).toBe('start');
    expect(payload.callId).toBe('call-1');
    expect(payload.agentId).toBe('agent-1');
    expect(payload.listenerId).toBe('inst-1');
    expect(payload.callerId).toBe('+1000');
    expect(payload.calledId).toBe('+2000');
    expect(typeof payload.timestamp).toBe('string');
  });

  test('signCallHookPayload produces deterministic hash', () => {
    const hash1 = signCallHookPayload({
      hashKey: 'secret',
      callId: 'call-1',
      listenerId: 'inst-1',
      agentId: 'agent-1'
    });

    const hash2 = signCallHookPayload({
      hashKey: 'secret',
      callId: 'call-1',
      listenerId: 'inst-1',
      agentId: 'agent-1'
    });

    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe('string');
    expect(hash1.length).toBeGreaterThan(0);
  });
});


