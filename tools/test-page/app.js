// Joins a LiveKit room for one agent, the same way @aplisay/react-widget does:
// activate a WebRTC listener, ask the API to join it, connect with livekit-client.
// The page is served next to the API (see nginx.conf), so API paths are relative.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { room: null, listenerId: null };

  const status = (text) => { $('status').textContent = text; };
  const log = (text) => { $('log').textContent += `${new Date().toLocaleTimeString()} ${text}\n`; };
  const key = () => $('apiKey').value.trim();

  async function api(path, { method = 'GET', body, bearer = key() } = {}) {
    const response = await fetch(`/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `${method} ${path}: HTTP ${response.status}`);
    return data;
  }

  function addLine(who, text) {
    const line = document.createElement('div');
    line.innerHTML = '<span class="who"></span><span class="text"></span>';
    line.querySelector('.who').textContent = who;
    line.querySelector('.text').textContent = text;
    $('transcript').appendChild(line);
  }

  $('load').onclick = async () => {
    try {
      const agents = await api('/agents');
      const list = Array.isArray(agents) ? agents : (agents.agents || []);
      const select = $('agent');
      select.innerHTML = '';
      for (const agent of list) {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = `${agent.name || agent.id} (${agent.modelName})`;
        select.appendChild(option);
      }
      select.disabled = list.length === 0;
      $('start').disabled = list.length === 0;
      status(list.length ? `${list.length} agent(s). Pick one and start.` : 'No agents yet. Create one with POST /api/agents.');
    } catch (err) {
      status(`Could not load agents: ${err.message}`);
    }
  };

  $('start').onclick = async () => {
    $('start').disabled = true;
    try {
      const agentId = $('agent').value;
      status('Activating a WebRTC listener...');
      const listener = await api(`/agents/${agentId}/listen`, { method: 'POST', body: {} });
      state.listenerId = listener.id;
      status('Joining the room...');
      const joined = await api(`/rooms/${listener.id}/join`, { method: 'POST', body: {}, bearer: listener.key });
      if (!joined.livekit) throw new Error('this page supports LiveKit agents only');
      const { serverUrl, participantToken } = joined.livekit;
      log(`room ${joined.livekit.roomName} on ${serverUrl}`);

      const { Room, RoomEvent, Track } = window.LivekitClient;
      const room = new Room();
      state.room = room;
      const decoder = new TextDecoder();
      room
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) document.body.appendChild(track.attach());
        })
        .on(RoomEvent.ParticipantConnected, (p) => log(`joined: ${p.identity}`))
        .on(RoomEvent.DataReceived, (payload) => {
          try {
            const data = JSON.parse(decoder.decode(payload));
            if (data.agent) addLine('Agent', data.agent);
            if (data.user) addLine('You', data.user);
            if (data.status) log(`agent status: ${data.status}`);
          } catch { /* not JSON */ }
        })
        .on(RoomEvent.Disconnected, () => { status('Disconnected.'); });
      await room.connect(serverUrl, participantToken);
      await room.localParticipant.setMicrophoneEnabled(true);
      status('Connected. Speak to the agent.');
      $('stop').disabled = false;
    } catch (err) {
      status(`Could not start: ${err.message}`);
      $('start').disabled = false;
    }
  };

  $('stop').onclick = async () => {
    $('stop').disabled = true;
    if (state.room) await state.room.disconnect();
    if (state.listenerId) await api(`/listener/${state.listenerId}`, { method: 'DELETE' }).catch((err) => log(err.message));
    state.room = null;
    state.listenerId = null;
    $('start').disabled = false;
    status('Stopped.');
  };
})();
