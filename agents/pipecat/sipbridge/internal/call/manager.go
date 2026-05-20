// Package call is the per-call orchestrator. One Call owns:
//   - the SIP dialog (passed in as identifier; the sip package keeps
//     the actual sipgo session state)
//   - an RTP session (UDP socket pair, codec-payload-level I/O)
//   - a Pipecat WebSocket connection
//
// The Manager owns a registry of Calls keyed by SIP Call-ID, and
// exposes the InviteHandler / ByeHandler the sip package needs to wire
// inbound calls into a Call.
package call

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/codec"
	pcclient "github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/pipecat"
	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/rtp"
	sipx "github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/sip"
)

// Config carries everything Manager needs to set up a per-call media
// path. Sourced from internal/config at startup.
type Config struct {
	// Base WS URL to the Pipecat worker — we tack /sipbridge/agent/{session_id}
	// to it. Example: "ws://pipecat-worker:8082".
	WorkerWSBase string
	// IP advertised in our SDP answer (c=, m=).
	MediaIP string
	// IP we bind the UDP RTP socket on. Defaults to MediaIP.
	MediaBindIP string
	// Even-numbered port range for RTP (inclusive).
	RTPPortMin int
	RTPPortMax int
}

// Manager is the per-process owner of all active calls.
type Manager struct {
	cfg Config
	sip *sipx.Server

	mu    sync.Mutex
	calls map[string]*Call // keyed by SIP Call-ID
}

// New returns a Manager. Caller is responsible for calling
// RegisterSIP with the sip server so handlers are wired up.
func New(cfg Config) *Manager {
	if cfg.MediaBindIP == "" {
		cfg.MediaBindIP = cfg.MediaIP
	}
	if cfg.RTPPortMin == 0 {
		cfg.RTPPortMin = 10000
	}
	if cfg.RTPPortMax == 0 {
		cfg.RTPPortMax = 20000
	}
	return &Manager{
		cfg:   cfg,
		calls: make(map[string]*Call),
	}
}

// RegisterSIP wires the manager into a sip server's handler hooks and
// retains the handle so outbound Originate / Transfer / Hangup can
// reach the SIP layer.
func (m *Manager) RegisterSIP(srv *sipx.Server) {
	m.sip = srv
	srv.SetInviteHandler(m.onInvite)
	srv.SetByeHandler(m.onBye)
}

// ActiveCallIDs returns a snapshot of the currently-live SIP Call-IDs
// for diagnostics.
func (m *Manager) ActiveCallIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.calls))
	for id := range m.calls {
		out = append(out, id)
	}
	return out
}

// Hangup terminates an active call by its SIP Call-ID. Tears down the
// media path and sends a SIP BYE in whichever direction the dialog
// has. Idempotent — multiple calls for the same id are silently fine.
func (m *Manager) Hangup(ctx context.Context, callID string) error {
	m.mu.Lock()
	c, ok := m.calls[callID]
	if ok {
		delete(m.calls, callID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("call: unknown call_id %q", callID)
	}
	// SIP-side BYE first so the far end starts terminating; then
	// release our local media. Errors on BYE are non-fatal — we
	// continue with media teardown either way.
	if m.sip != nil {
		if err := m.sip.Hangup(ctx, callID); err != nil {
			log.Warn().Err(err).Str("call_id", callID).Msg("call: BYE failed during hangup")
		}
	}
	c.Close()
	return nil
}

// OriginateParams carries everything the REST `POST /v1/calls` body
// needs to feed to ``Originate``.
type OriginateParams struct {
	Destination     string            // SIP URI or bare number
	CallerID        string            // From: User part
	AgentSessionID  string            // session_id to use in the worker WS URL
	CustomHeaders   map[string]string // X-Aplisay-* etc.
	Metadata        map[string]string // free-form; included as X-Aplisay-Call-Id when present
}

// Originate places an outbound INVITE through the SIP layer, then
// (after the 200 OK / SDP answer arrives) wires the per-call RTP +
// Pipecat WS just like the inbound path.
//
// Returns the bridge's internal call_id on success; the worker uses
// that for follow-up REST calls (DELETE, transfer).
func (m *Manager) Originate(ctx context.Context, p OriginateParams) (string, error) {
	if m.sip == nil {
		return "", errors.New("call: SIP layer not registered")
	}
	if p.AgentSessionID == "" {
		return "", errors.New("call: AgentSessionID is required")
	}

	// 1. Allocate the local RTP socket so we can publish our endpoint
	// in the SDP offer.
	rtpSess, err := rtp.NewSession(m.cfg.MediaBindIP, m.cfg.RTPPortMin, m.cfg.RTPPortMax)
	if err != nil {
		return "", fmt.Errorf("call: rtp: %w", err)
	}

	offer := sipx.BuildOffer(rtpSess, m.cfg.MediaIP)

	// Inject X-Aplisay-Call-Id from metadata if present — the upstream
	// B2BUA uses this as the platform-wide call correlator.
	custom := map[string]string{}
	for k, v := range p.CustomHeaders {
		custom[k] = v
	}
	if v, ok := p.Metadata["aplisay_call_id"]; ok && custom["X-Aplisay-Call-Id"] == "" {
		custom["X-Aplisay-Call-Id"] = v
	}

	// 2. Send INVITE and wait for the 200 OK + SDP answer.
	out, _, err := m.sip.Originate(ctx, p.Destination, offer, custom)
	if err != nil {
		rtpSess.Close()
		return "", fmt.Errorf("call: originate: %w", err)
	}

	// 3. Wire RTP to the remote endpoint the SDP answer published.
	answer := out.Answer
	if answer.RemoteIP == "" || answer.RemotePort == 0 {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return "", errors.New("call: SDP answer missing remote endpoint")
	}
	if err := rtpSess.SetRemote(answer.RemoteIP, answer.RemotePort); err != nil {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return "", fmt.Errorf("call: rtp remote: %w", err)
	}
	pt := rtp.PayloadPCMU
	if !answer.HasPCMU && answer.HasPCMA {
		pt = rtp.PayloadPCMA
	} else if !answer.HasPCMU && !answer.HasPCMA {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return "", errors.New("call: no acceptable codec in answer")
	}
	rtpSess.SetPayloadType(pt)

	// 4. Open the Pipecat WS using the session_id supplied by the
	// worker (which is waiting on a future keyed by that id).
	wsURL, err := joinWSPath(m.cfg.WorkerWSBase, "/sipbridge/agent/"+url.PathEscape(p.AgentSessionID))
	if err != nil {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return "", fmt.Errorf("call: ws url: %w", err)
	}

	pc := pcclient.NewClient(wsURL)
	c := &Call{
		callID:    out.CallID,
		sessionID: p.AgentSessionID,
		rtp:       rtpSess,
		ws:        pc,
		payload:   pt,
		jb:        rtp.NewJitterBuffer(3, 160),
		closed:    make(chan struct{}),
	}
	releaseCtx, releaseCancel := context.WithCancel(context.Background())
	c.releaseStop = releaseCancel
	c.startJitterRelease(releaseCtx)

	rtpSess.SetPayloadHandler(c.onRTPPayload)
	pc.SetAudioHandler(c.onWSAudio)
	pc.SetCloseHandler(func(err error) {
		log.Info().Str("call_id", out.CallID).Err(err).Msg("call: ws closed (outbound)")
		c.Close()
	})

	// Stamp the same headers we sent on the INVITE onto the WS so the
	// worker's lookup chain has them available. The bridge already
	// knows everything the worker needs.
	hdr := http.Header{}
	hdr.Set("X-Sipbridge-Call-ID", out.CallID)
	for k, v := range custom {
		hdr.Set(k, v)
	}

	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pc.Connect(dctx, hdr); err != nil {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return "", fmt.Errorf("call: pipecat ws connect: %w", err)
	}

	rtpSess.Start(context.Background())

	m.mu.Lock()
	m.calls[out.CallID] = c
	m.mu.Unlock()

	log.Info().
		Str("call_id", out.CallID).
		Str("session_id", p.AgentSessionID).
		Str("ws_url", wsURL).
		Int("rtp_port", rtpSess.LocalAddr().Port).
		Msg("call: outbound ready")
	return out.CallID, nil
}

// Transfer sends a REFER on an existing call or installs a media
// relay between two existing calls.
//
//   - mode "blind" or "": in-dialog REFER on ``callID`` pointing at
//     ``target``. The far end drives the new INVITE; we leave the
//     dialog open until BYE arrives (carrier sends BYE on
//     transfer-completed).
//   - mode "bridged": ``target`` is interpreted as a second call_id
//     (a previously-started consult leg via /v1/calls/{id}/consult).
//     The bridge installs an in-process media relay between the two
//     calls, closes both Pipecat WSes, and keeps the SIP dialogs open
//     until either side BYEs (at which point both get cleaned up).
//   - mode "consult": invalid for the transfer endpoint — clients
//     should call the dedicated /v1/calls/{id}/consult endpoint.
func (m *Manager) Transfer(ctx context.Context, callID, target, mode string) error {
	if m.sip == nil {
		return errors.New("call: SIP layer not registered")
	}
	switch mode {
	case "", "blind":
		return m.sip.Refer(ctx, callID, target)
	case "bridged":
		return m.BridgeRelay(callID, target)
	case "consult":
		return errors.New("call: use /v1/calls/{id}/consult endpoint for consult, not /transfer")
	default:
		return fmt.Errorf("call: unknown transfer mode %q", mode)
	}
}

// BridgeRelay puts two existing calls into peer-to-peer media-relay
// mode. Both calls keep their SIP dialogs alive; their RTP send paths
// get re-pointed at each other and their Pipecat WSes are closed.
//
// Pre-conditions: both calls must already exist as Call instances in
// the manager (i.e. successfully ANSWERED on the SIP side). Codec
// must be compatible (Phase C v1 supports same-family G.711 only —
// PCMU↔PCMU or PCMA↔PCMA. Cross-family relay (mu↔A) needs a
// transcoding step in the codec layer; tracked as follow-up).
func (m *Manager) BridgeRelay(callA, callB string) error {
	m.mu.Lock()
	a, okA := m.calls[callA]
	b, okB := m.calls[callB]
	m.mu.Unlock()
	if !okA {
		return fmt.Errorf("call: bridge: unknown call_id %q (A)", callA)
	}
	if !okB {
		return fmt.Errorf("call: bridge: unknown call_id %q (B)", callB)
	}
	if a.payload != b.payload {
		// Cross-family mu↔A would need a transcoding step we don't
		// have yet. Reject explicitly so the worker can surface a
		// clean error to the bot instead of producing broken audio.
		return fmt.Errorf(
			"call: bridge: codec mismatch (A=%d, B=%d) — same-family required for Phase C v1",
			a.payload, b.payload,
		)
	}
	a.SetPeer(b)
	b.SetPeer(a)
	log.Info().
		Str("call_a", callA).
		Str("call_b", callB).
		Msg("call: media relay installed (bridged transfer)")
	return nil
}

// ConsultParams is what the REST /v1/calls/{id}/consult endpoint
// passes through to ``Consult``. The original call (``OriginalCallID``)
// stays unaffected — bot_A keeps talking to caller A. We dial
// ``Destination`` as a fresh outbound leg, open a NEW Pipecat WS to
// the worker at the supplied ``AgentSessionID``, and return the
// resulting consult call_id so the worker can use it later as the
// ``target`` of a bridged transfer.
type ConsultParams struct {
	OriginalCallID  string
	Destination     string
	CallerID        string
	AgentSessionID  string
	CustomHeaders   map[string]string
	Metadata        map[string]string
}

// Consult dials a second SIP leg for the consult phase of a warm
// transfer, attaching it to a fresh Pipecat bot session on the worker.
//
// Returns the consult call_id, which the caller passes as ``target``
// (with mode="bridged") to /v1/calls/{original}/transfer when ready
// to finalize the bridge. For blind transfer, the worker discards the
// consult call_id and uses /transfer with mode=blind on the original
// leg directly.
func (m *Manager) Consult(ctx context.Context, p ConsultParams) (string, error) {
	// The original must still be live — we don't actually need its
	// state during consult (the legs are independent during this
	// phase), but verifying makes the error message clearer.
	m.mu.Lock()
	_, ok := m.calls[p.OriginalCallID]
	m.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("call: consult: unknown original call_id %q", p.OriginalCallID)
	}

	// The consult leg is structurally identical to an outbound
	// originate — fresh INVITE, fresh RTP socket, fresh WS to the
	// worker. We re-use Originate and stash the resulting call_id.
	consultID, err := m.Originate(ctx, OriginateParams{
		Destination:    p.Destination,
		CallerID:       p.CallerID,
		AgentSessionID: p.AgentSessionID,
		CustomHeaders:  p.CustomHeaders,
		Metadata:       p.Metadata,
	})
	if err != nil {
		return "", fmt.Errorf("call: consult: %w", err)
	}
	log.Info().
		Str("original", p.OriginalCallID).
		Str("consult", consultID).
		Str("destination", p.Destination).
		Msg("call: consult leg established")
	return consultID, nil
}

// onInvite handles a parsed INVITE: allocates RTP, opens the Pipecat
// WS, returns the SDP answer body.
func (m *Manager) onInvite(
	ctx context.Context, callID string, offer *sipx.CodecOffer, headers sipx.IncomingHeaders,
) ([]byte, error) {
	if offer.RemoteIP == "" || offer.RemotePort == 0 {
		return nil, errors.New("call: INVITE SDP missing remote endpoint")
	}

	// 1. Allocate the RTP socket.
	rtpSess, err := rtp.NewSession(m.cfg.MediaBindIP, m.cfg.RTPPortMin, m.cfg.RTPPortMax)
	if err != nil {
		return nil, fmt.Errorf("call: rtp setup: %w", err)
	}
	if err := rtpSess.SetRemote(offer.RemoteIP, offer.RemotePort); err != nil {
		rtpSess.Close()
		return nil, fmt.Errorf("call: rtp remote: %w", err)
	}

	// 2. Build SDP answer + decide codec.
	answer, pt, err := sipx.BuildAnswer(offer, rtpSess, m.cfg.MediaIP)
	if err != nil {
		rtpSess.Close()
		return nil, fmt.Errorf("call: sdp answer: %w", err)
	}
	rtpSess.SetPayloadType(pt)

	// 3. Build the per-session Pipecat WS URL and open the WS.
	sessionID := pickSessionID(callID, headers)
	wsURL, err := joinWSPath(m.cfg.WorkerWSBase, "/sipbridge/agent/"+url.PathEscape(sessionID))
	if err != nil {
		rtpSess.Close()
		return nil, fmt.Errorf("call: ws url: %w", err)
	}

	pc := pcclient.NewClient(wsURL)
	c := &Call{
		callID:    callID,
		sessionID: sessionID,
		rtp:       rtpSess,
		ws:        pc,
		payload:   pt,
		jb:        rtp.NewJitterBuffer(3, 160),
		closed:    make(chan struct{}),
	}
	releaseCtx, releaseCancel := context.WithCancel(context.Background())
	c.releaseStop = releaseCancel
	c.startJitterRelease(releaseCtx)

	// 4. Wire callbacks. Both directions go through the codec layer.
	rtpSess.SetPayloadHandler(c.onRTPPayload)
	pc.SetAudioHandler(c.onWSAudio)
	pc.SetCloseHandler(func(err error) {
		log.Info().Str("call_id", callID).Err(err).Msg("call: ws closed")
		c.Close()
	})

	// 5. Open the WS (with a short timeout to keep the SIP transaction
	// responsive). If the worker is down we want a clean 5xx, not a
	// hanging 100 Trying.
	//
	// The SIP-derived metadata rides as X-Sipbridge-* request headers
	// so the worker can resolve the agent at WS accept time. This is
	// the equivalent of voiceblender's VSI ``leg.ringing`` event with
	// its ``custom_headers`` field, but inline on the WS opening
	// handshake (no separate event channel needed).
	hdr := http.Header{}
	hdr.Set("X-Sipbridge-Call-ID", callID)
	if headers.From != "" {
		hdr.Set("X-Sipbridge-From", headers.From)
	}
	if headers.To != "" {
		hdr.Set("X-Sipbridge-To", headers.To)
	}
	if headers.AplisayTrunk != "" {
		hdr.Set("X-Aplisay-Trunk", headers.AplisayTrunk)
	}
	if headers.AplisayPhoneRegistration != "" {
		hdr.Set("X-Aplisay-PhoneRegistration", headers.AplisayPhoneRegistration)
	}
	if headers.AplisayCallID != "" {
		hdr.Set("X-Aplisay-Call-Id", headers.AplisayCallID)
	}
	if headers.AplisayB2BUAGatewayIP != "" {
		hdr.Set("X-Lk-RealIp", headers.AplisayB2BUAGatewayIP)
	}
	if headers.AplisayB2BUATransport != "" {
		hdr.Set("X-Lk-Transport", headers.AplisayB2BUATransport)
	}

	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pc.Connect(dctx, hdr); err != nil {
		rtpSess.Close()
		return nil, fmt.Errorf("call: pipecat ws connect: %w", err)
	}

	// 6. Spawn the RTP read goroutine. From here on, audio flows.
	rtpSess.Start(context.Background())

	m.mu.Lock()
	m.calls[callID] = c
	m.mu.Unlock()

	log.Info().
		Str("call_id", callID).
		Str("session_id", sessionID).
		Str("ws_url", wsURL).
		Int("rtp_port", rtpSess.LocalAddr().Port).
		Msg("call: ready")
	return answer, nil
}

func (m *Manager) onBye(callID string) {
	m.mu.Lock()
	c, ok := m.calls[callID]
	if ok {
		delete(m.calls, callID)
	}
	m.mu.Unlock()
	if ok {
		c.Close()
	}
}

// pickSessionID picks a stable session_id for the worker WS URL. If the
// upstream B2BUA stamped X-Aplisay-Call-Id we use it (so logs correlate
// end-to-end); otherwise we use the SIP Call-ID. Either way the worker
// just gets a unique opaque token.
func pickSessionID(callID string, h sipx.IncomingHeaders) string {
	if h.AplisayCallID != "" {
		return h.AplisayCallID
	}
	return callID
}

// joinWSPath concatenates a ws:// base with a path. The standard library
// url.JoinPath handles the path normalisation; we just preserve the ws
// scheme.
func joinWSPath(base, path string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u.Path = path
	return u.String(), nil
}

// ---- Call ---------------------------------------------------------------

// Call holds the per-call media + protocol state.
//
// In the Pipecat-bot mode (the default), inbound RTP gets decoded,
// upsampled, framed as AudioRawFrame, and shipped over `ws` to the
// worker. The worker's bot output flows the other direction.
//
// In **relay mode** (Phase C, set via SetPeer on both sides of a
// bridged transfer), inbound RTP gets forwarded directly to the peer
// Call's RTP session — both endpoints are 8 kHz G.711, so no codec
// touch is required. The `ws` connection is closed during peer
// installation because the worker no longer participates in the audio
// path; the bots that were talking to A and C respectively are torn
// down, and the bridge becomes a transparent SIP+RTP B2BUA.
type Call struct {
	callID    string
	sessionID string

	rtp     *rtp.Session
	ws      *pcclient.Client
	payload rtp.PayloadType

	// jb (Phase D) reorders inbound RTP packets by sequence number
	// and releases them at a steady 20 ms cadence. Smooths out small
	// amounts of network jitter and absorbs occasional reordering;
	// gaps are filled with silence packets. ``releaseStop`` cancels
	// the release-loop goroutine on call close.
	jb           *rtp.JitterBuffer
	releaseStop  context.CancelFunc

	mu     sync.Mutex
	closed chan struct{}
	done   bool

	// peer is set by SetPeer when this call has been bridged into a
	// media-relay with another Call. While non-nil, onRTPPayload
	// forwards instead of going through the codec / WS path, and the
	// jitter buffer is bypassed (relay packets pass straight through
	// to keep the bridged path minimum-latency).
	peer *Call
}

// SetPeer puts the call into media-relay mode by stapling it to its
// peer. The other side of the bridge must call SetPeer with this one
// before the audio path becomes fully duplex.
//
// SetPeer is idempotent and may be called once per call. After SetPeer
// the call's `ws` is closed — the worker no longer participates in
// audio — and the jitter-buffer release loop is stopped since the
// relay path forwards packets immediately without reordering.
func (c *Call) SetPeer(peer *Call) {
	c.mu.Lock()
	c.peer = peer
	if c.jb != nil {
		c.jb.Reset()
	}
	c.mu.Unlock()
	// Stop the release ticker; relay mode owns the inbound path now.
	if c.releaseStop != nil {
		c.releaseStop()
		c.releaseStop = nil
	}
	if c.ws != nil {
		c.ws.Stop()
	}
}

// onRTPPayload is called by the RTP read loop for each inbound packet.
//
// In relay mode (Phase C bridged transfer) we forward the codec
// payload to the peer's RTP session unchanged — both legs are 8 kHz
// G.711 so no codec touch is needed and the relay adds only a single
// UDP write of latency per packet. The jitter buffer is bypassed
// because both ends of the relay see comparable jitter and adding
// our own reordering layer doesn't improve anything.
//
// Otherwise (default Pipecat-bot mode) we route by payload type:
//
//   - PT 101 (RFC 4733 telephone-event): parse the DTMF event and
//     surface it to the worker as a MessageFrame with a small JSON
//     payload. We forward only on the end-of-event packet to avoid
//     spamming the worker with one frame per RTP packet for the
//     duration of a key-press (DTMF events typically span 50-200 ms
//     and produce 3-10 RTP packets per press).
//
//   - Anything else (G.711 audio): push into the jitter buffer for
//     the release loop to drain.
func (c *Call) onRTPPayload(pt rtp.PayloadType, seq uint16, payload []byte, _ bool) {
	if c.isClosed() {
		return
	}
	c.mu.Lock()
	peer := c.peer
	c.mu.Unlock()
	if peer != nil {
		if err := peer.rtp.SendPayload(payload); err != nil {
			log.Warn().Err(err).
				Str("from", c.callID).
				Str("to", peer.callID).
				Msg("call: relay forward failed")
			c.Close()
		}
		return
	}

	if pt == rtp.PayloadDTMF {
		c.handleDTMF(payload)
		return
	}

	if c.jb != nil {
		c.jb.Push(seq, payload)
	}
}

// handleDTMF parses an RFC 4733 telephone-event payload and, on the
// end-of-event flag, ships a MessageFrame to the worker with a small
// JSON describing the press: ``{"dtmf":"5","duration_ms":120}``.
//
// We avoid emitting on every packet of a long press because Pipecat's
// MessageFrame channel is meant for occasional events, not a stream;
// the end packet carries the cumulative duration so the worker has
// all the info it needs from a single notification.
func (c *Call) handleDTMF(payload []byte) {
	ev, ok := rtp.ParseDTMF(payload)
	if !ok {
		return
	}
	if !ev.End {
		// Continuation packet — silently absorbed. RFC 4733 says the
		// receiver MAY use these to track ongoing duration but we
		// only need the final.
		return
	}
	sym := ev.Symbol()
	if sym == 0 {
		return
	}
	// Duration is in samples at 8 kHz — convert to ms for ease of use.
	durationMS := int(uint32(ev.Duration) / 8)
	msg := fmt.Sprintf(
		`{"type":"dtmf","digit":%q,"duration_ms":%d,"call_id":%q}`,
		string(sym), durationMS, c.callID,
	)
	if c.ws == nil {
		return
	}
	if err := c.ws.SendMessage(msg); err != nil {
		log.Warn().Err(err).Str("call_id", c.callID).Msg("call: dtmf ws send failed")
	}
}

// processDecodedPayload runs the codec → upsample → WS path for one
// 20 ms RTP payload. Called by the jitter-buffer release loop.
func (c *Call) processDecodedPayload(payload []byte) {
	var samples8k []int16
	switch c.payload {
	case rtp.PayloadPCMU:
		samples8k = codec.DecodePCMU(payload)
	case rtp.PayloadPCMA:
		samples8k = codec.DecodePCMA(payload)
	default:
		return
	}
	samples16k := codec.Upsample8To16(samples8k)
	if err := c.ws.SendAudio(codec.PCMS16LEToBytes(samples16k)); err != nil {
		log.Warn().Err(err).Str("call_id", c.callID).Msg("call: ws send failed")
		c.Close()
	}
}

// startJitterRelease starts the 20 ms ticker that drains the JB. Runs
// until the call closes (closure detected via ctx) or relay mode
// engages (SetPeer drains/stops the buffer).
func (c *Call) startJitterRelease(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Millisecond)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if c.isClosed() {
					return
				}
				c.mu.Lock()
				peer := c.peer
				jb := c.jb
				c.mu.Unlock()
				if peer != nil || jb == nil {
					// Relay mode took over (peer set) or call closed
					// (jb nil) — nothing to do this tick.
					continue
				}
				payload, _ := jb.Pop()
				if payload == nil {
					// Buffer not yet at target depth — skip until it
					// fills.
					continue
				}
				c.processDecodedPayload(payload)
			}
		}
	}()
}

// onWSAudio is called when the worker pushes a bot-side AudioRawFrame
// down the WS. PCM16LE @ 16 kHz mono in, RTP-encoded at 8 kHz on the
// wire.
//
// Pipecat batches its audio output in roughly-20-ms chunks (320
// samples), which happens to be exactly one downsampled RTP frame at
// 8 kHz. Larger chunks are split into 160-sample (20 ms) RTP packets
// to match the negotiated ptime — most carriers and SBCs enforce this.
func (c *Call) onWSAudio(pcm16LEbytes []byte) {
	if c.isClosed() {
		return
	}
	samples16k := codec.BytesToPCMS16LE(pcm16LEbytes)
	samples8k := codec.Downsample16To8(samples16k)

	const samplesPerPacket = 160 // 20 ms at 8 kHz
	for i := 0; i < len(samples8k); i += samplesPerPacket {
		end := i + samplesPerPacket
		if end > len(samples8k) {
			end = len(samples8k)
		}
		chunk := samples8k[i:end]
		var payload []byte
		switch c.payload {
		case rtp.PayloadPCMU:
			payload = codec.EncodePCMU(chunk)
		case rtp.PayloadPCMA:
			payload = codec.EncodePCMA(chunk)
		default:
			return
		}
		if err := c.rtp.SendPayload(payload); err != nil {
			log.Warn().Err(err).Str("call_id", c.callID).Msg("call: rtp send failed")
			c.Close()
			return
		}
	}
}

// Close tears down RTP + WS + jitter buffer release loop. Idempotent.
func (c *Call) Close() {
	c.mu.Lock()
	if c.done {
		c.mu.Unlock()
		return
	}
	c.done = true
	close(c.closed)
	c.mu.Unlock()
	if c.releaseStop != nil {
		c.releaseStop()
	}
	if c.rtp != nil {
		c.rtp.Close()
	}
	if c.ws != nil {
		c.ws.Stop()
	}
}

func (c *Call) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}
