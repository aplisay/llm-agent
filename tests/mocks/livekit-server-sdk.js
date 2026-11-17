// Every jest config maps `livekit-server-sdk` to this file, so no test can
// create a real LiveKit room, agent dispatch or SIP call, whatever LiveKit
// credentials the environment holds. Token classes stay real; the server API
// clients only record their calls.
//
// A relative path, because the bare name would map back to this file.
export * from '../../node_modules/livekit-server-sdk/dist/index.js';

/** Every server API call made in this test file, oldest first. */
export const livekitApiCalls = [];

const results = {
  createDispatch: (room, agentName, options = {}) => ({
    id: `AD_test_${livekitApiCalls.length}`,
    agentName,
    room,
    metadata: options.metadata ?? '',
  }),
};

const recordingClient = (client) => class {
  constructor() {
    // A Proxy so a method the SDK adds later is recorded too, not sent.
    return new Proxy(this, {
      get(target, method) {
        if (typeof method === 'symbol' || method === 'then' || method in target) {
          return target[method];
        }
        return async (...args) => {
          livekitApiCalls.push({ client, method, args });
          return results[method]?.(...args) ?? {};
        };
      },
    });
  }
};

export const AgentDispatchClient = recordingClient('AgentDispatchClient');
export const ConnectorClient = recordingClient('ConnectorClient');
export const EgressClient = recordingClient('EgressClient');
export const IngressClient = recordingClient('IngressClient');
export const RoomServiceClient = recordingClient('RoomServiceClient');
export const SipClient = recordingClient('SipClient');
