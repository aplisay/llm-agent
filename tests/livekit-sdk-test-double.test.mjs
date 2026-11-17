// The jest configs map livekit-server-sdk to tests/mocks/livekit-server-sdk.js.
// If this suite fails, tests may be creating real rooms and dispatches on
// whatever LiveKit server the environment's credentials point at.
import { AccessToken, AgentDispatchClient, SipClient, TokenVerifier } from 'livekit-server-sdk';
import { livekitApiCalls } from './mocks/livekit-server-sdk.js';

const url = 'wss://livekit.invalid';

describe('livekit-server-sdk in tests', () => {
  beforeEach(() => {
    livekitApiCalls.length = 0;
  });

  test('a dispatch is recorded, not sent', async () => {
    const client = new AgentDispatchClient(url, 'key', 'secret');
    const dispatch = await client.createDispatch('outbound-room', 'realtime', { metadata: '{"a":1}' });

    expect(dispatch).toMatchObject({ room: 'outbound-room', agentName: 'realtime', metadata: '{"a":1}' });
    expect(livekitApiCalls).toEqual([
      { client: 'AgentDispatchClient', method: 'createDispatch', args: ['outbound-room', 'realtime', { metadata: '{"a":1}' }] },
    ]);
  });

  test('a SIP participant is recorded, not dialled', async () => {
    const client = new SipClient(url, 'key', 'secret');
    await client.createSipParticipant('ST_trunk', '+447700900123', 'room');

    expect(livekitApiCalls).toEqual([
      { client: 'SipClient', method: 'createSipParticipant', args: ['ST_trunk', '+447700900123', 'room'] },
    ]);
  });

  test('tokens are still real', async () => {
    const secret = 'a-test-secret-that-is-at-least-32-chars';
    const token = new AccessToken('key', secret, { identity: 'someone' });
    token.addGrant({ room: 'room', roomJoin: true });

    const claims = await new TokenVerifier('key', secret).verify(await token.toJwt());
    expect(claims.sub).toBe('someone');
    expect(claims.video).toMatchObject({ room: 'room', roomJoin: true });
  });
});
