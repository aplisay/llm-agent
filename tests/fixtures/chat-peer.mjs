// A second server process for tests/chat-session-handoff.test.mjs.
//
// Usage: node tests/fixtures/chat-peer.mjs '<json>'
//   json = { id, say?, keep?, tag? }
//
// Connects to the same database with the POSTGRES_* variables it is given,
// listens for ownership requests like a server does, and then does what a
// browser reconnecting through the load balancer to THIS process would cause:
// attaches a socket to session `id`, which makes this process claim the
// session (asking the current owner to hand it over if one is alive). With
// `say` it then sends one user message and waits for the turn to finish. It
// prints one JSON line describing what happened and exits. By default it
// releases its sessions on the way out, as a server does on SIGTERM; with
// `keep` it exits still holding the row, which is what a crash looks like.
const spec = JSON.parse(process.argv[2] || '{}');

try {
  const { FakeChatLlm } = await import('./fake-chat-llm.mjs');
  const { FakeWs } = await import('./fake-ws.mjs');
  const { databaseStarted, stopDatabase, ChatSession } = await import('../../lib/database.js');
  const {
    setChatLlmFactory, attachChatSession, getChatSession,
    startChatOwnershipListener, stopChatOwnershipListener, releaseAllChatSessions,
  } = await import('../../lib/text-chat.js');
  const { PROCESS_ID } = await import('../../lib/process-id.js');

  await databaseStarted;
  setChatLlmFactory(() => new FakeChatLlm({ tag: spec.tag || 'peer' }));
  await startChatOwnershipListener();

  const ws = new FakeWs();
  const t0 = Date.now();
  await attachChatSession(spec.id, ws);
  const attachedMs = Date.now() - t0;
  const session = getChatSession(spec.id);
  const rowAfterClaim = await ChatSession.findByPk(spec.id, { attributes: ['owner'] });

  if (spec.say && session) {
    ws.say(spec.say);
    await ws.waitFor((f) => f.type === 'turn_complete', { what: 'turn_complete' });
  }

  const out = {
    processId: PROCESS_ID,
    attachedMs,
    held: !!session,
    imported: session?.llm?.imported ?? null,
    messages: session?.llm?.messages?.length ?? null,
    ownerAfterClaim: rowAfterClaim?.owner ?? null,
    frames: ws.frames,
  };

  if (!spec.keep) await releaseAllChatSessions();
  await stopChatOwnershipListener().catch(() => {});
  console.log(JSON.stringify(out));
  await Promise.race([
    stopDatabase(),
    new Promise((resolve) => { setTimeout(resolve, 5000).unref?.(); }),
  ]);
  process.exit(0);
}
catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
