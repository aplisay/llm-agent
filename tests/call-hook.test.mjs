import { createHmac } from 'node:crypto';
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
    // The three lineage fields are always present, null when the row has none.
    expect(payload.organisationId).toBeNull();
    expect(payload.parentId).toBeNull();
    expect(payload.modelName).toBeNull();
  });

  test('buildCallHookPayload carries organisationId, parentId and modelName from the call row on both events', () => {
    const call = {
      id: 'call-2',
      agentId: 'agent-1',
      instanceId: 'inst-1',
      organisationId: 'org-1',
      parentId: 'call-1',
      modelName: 'telephony:bridged-call',
      callerId: '+1000',
      calledId: '+2000',
      duration: 61400,
    };
    const start = buildCallHookPayload({ event: 'start', call, agent: null, listenerOrInstance: null });
    expect(start).toMatchObject({ event: 'start', callId: 'call-2', organisationId: 'org-1', parentId: 'call-1', modelName: 'telephony:bridged-call' });
    expect(start).not.toHaveProperty('durationSeconds');
    const end = buildCallHookPayload({ event: 'end', call, agent: null, listenerOrInstance: null, reason: 'normal_hangup' });
    expect(end).toMatchObject({
      event: 'end', callId: 'call-2', organisationId: 'org-1', parentId: 'call-1', modelName: 'telephony:bridged-call',
      reason: 'normal_hangup', durationSeconds: 61,
    });
  });

  test('buildCallHookPayload takes the lineage fields from the call row only, never from the agent', () => {
    const call = { id: 'call-3', agentId: 'agent-1' };
    const agent = { id: 'agent-1', organisationId: 'org-9', modelName: 'livekit:openai/gpt-4o' };
    const payload = buildCallHookPayload({ event: 'end', call, agent, listenerOrInstance: null });
    expect(payload).toMatchObject({ organisationId: null, modelName: null, parentId: null });
  });

  test('the hash covers hashKey, callId, listenerId and agentId and nothing else', () => {
    const call = { id: 'call-3', agentId: 'agent-1', instanceId: 'inst-1', organisationId: 'org-1', parentId: 'call-1', modelName: 'x' };
    const payload = buildCallHookPayload({ event: 'end', call, agent: null, listenerOrInstance: null, reason: 'r' });
    const hash = signCallHookPayload({ hashKey: 'k', ...payload });
    // HMAC-SHA256 of "k|call-3|inst-1|agent-1" with key "k", computed independently.
    const expected = createHmac('sha256', 'k').update('k|call-3|inst-1|agent-1').digest('hex');
    expect(hash).toBe(expected);
    expect(signCallHookPayload({ hashKey: 'k', ...payload, organisationId: 'other', modelName: 'other', parentId: 'other' })).toBe(expected);
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


