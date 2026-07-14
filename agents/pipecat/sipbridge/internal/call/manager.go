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
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	srtpv3 "github.com/pion/srtp/v3"
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

	// SRTPEnabled accepts encrypted-media offers (SDES + DTLS-SRTP)
	// from peers; plaintext is still accepted unless SRTPRequired.
	SRTPEnabled bool
	// SRTPRequired refuses plaintext-only offers with SIP 488 Not
	// Acceptable Here. Use when the bridge sits behind TLS signalling
	// and any plaintext peer is a misconfiguration.
	SRTPRequired bool
	// SRTPDTLSEnabled opts the DTLS-SRTP path in alongside SDES.
	// Has no effect when SRTPEnabled is false.
	SRTPDTLSEnabled bool
	// SRTPOutbound: when true, outbound originate offers SDES SRTP
	// (RTP/SAVP profile) instead of plaintext. The peer can answer
	// SDES (we install contexts and traffic is encrypted) or — in
	// stricter SBC configs — reject with 488 (we surface the failure
	// to the caller of Originate). When false, outbound originate
	// offers plain RTP/AVP regardless of SRTPEnabled.
	SRTPOutbound bool

	// RTPTimeoutSeconds: tear the call down (send BYE upstream + close
	// the worker WS) when no inbound RTP has arrived for this many
	// seconds. Covers peers — notably Twilio's Elastic SIP Trunk —
	// that stop sending media when the caller hangs up but never
	// send a BYE. 0 disables the watchdog. Default 10.
	RTPTimeoutSeconds int

	// DTLSCert is the X.509 cert (with private key) we use for
	// DTLS-SRTP handshakes. Reuse of the SIP TLS cert is recommended —
	// the same identity covers both signalling and media. nil disables
	// DTLS-SRTP regardless of SRTPDTLSEnabled.
	DTLSCert *tls.Certificate
	// DTLSFingerprint is the SHA-256 fingerprint of DTLSCert, in the
	// SDP ``a=fingerprint:`` wire form ("sha-256 AB:CD:..."). The
	// caller computes this once at startup (sipx.LoadOrGenerateCert
	// already returns the value) and passes it through. We don't
	// recompute per-call.
	DTLSFingerprint string
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
	if cfg.RTPTimeoutSeconds == 0 {
		cfg.RTPTimeoutSeconds = 10
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
	log.Info().Str("call_id", callID).Msg("call: hangup requested")
	m.mu.Lock()
	c, ok := m.calls[callID]
	if ok {
		delete(m.calls, callID)
	}
	m.mu.Unlock()
	if !ok {
		log.Warn().Str("call_id", callID).Msg("call: hangup for unknown call_id — already torn down?")
		return fmt.Errorf("call: unknown call_id %q", callID)
	}
	// SIP-side BYE first so the far end starts terminating; then
	// release our local media. Errors on BYE are non-fatal — we
	// continue with media teardown either way.
	if m.sip != nil {
		log.Info().Str("call_id", callID).Msg("call: sending BYE upstream")
		if err := m.sip.Hangup(ctx, callID); err != nil {
			log.Warn().Err(err).Str("call_id", callID).Msg("call: BYE failed during hangup")
		} else {
			log.Info().Str("call_id", callID).Msg("call: BYE upstream complete")
		}
	} else {
		log.Warn().Str("call_id", callID).Msg("call: no SIP layer registered — skipping BYE")
	}
	c.Close()
	return nil
}

// SendDTMF plays out-of-band RFC 4733 DTMF digits toward the far end of an
// active call. The digit string is validated (0-9, * and #) synchronously so
// a bad request fails fast; the burst itself (~200 ms/digit) is played on a
// background goroutine so the HTTP control call returns promptly. The call
// is left up — DTMF is in-dialog signalling, not a teardown.
func (m *Manager) SendDTMF(callID, digits string) error {
	if digits == "" {
		return fmt.Errorf("call: empty DTMF digit string")
	}
	for i := 0; i < len(digits); i++ {
		if _, ok := rtp.EventCode(digits[i]); !ok {
			return fmt.Errorf("call: invalid DTMF character %q (allowed: 0-9, * and #)", string(digits[i]))
		}
	}
	m.mu.Lock()
	c, ok := m.calls[callID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("call: unknown call_id %q", callID)
	}
	log.Info().Str("call_id", callID).Str("digits", digits).Msg("call: sending DTMF")
	go func() {
		if err := c.SendDTMF(context.Background(), digits); err != nil {
			log.Warn().Err(err).Str("call_id", callID).Str("digits", digits).Msg("call: DTMF send failed")
		}
	}()
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

// buildOutboundOffer builds the SDP offer for an outbound INVITE on ``rtpSess``.
// When ``offeringSDES`` it offers SDES SRTP (RTP/SAVP) with one ``a=crypto``
// line per catalogued suite (preference order) and returns the tag → master
// material map needed to install the SRTP context from the peer's answer.
// Otherwise it offers plaintext RTP/AVP and an empty map. Reusable so the
// dial path can re-offer plaintext after a 488 SRTP rejection.
//
// DTLS-SRTP outbound is not yet implemented — it needs the initiate-side
// handshake plus a=setup:actpass parsing of the answer; SDES is what every SBC
// supports anyway.
func (m *Manager) buildOutboundOffer(
	rtpSess *rtp.Session, offeringSDES bool,
) ([]byte, map[int]rtp.CryptoMaterial, error) {
	encOffer := sipx.EncryptionParams{}
	ourOfferedSDES := map[int]rtp.CryptoMaterial{}
	if offeringSDES {
		encOffer.Profile = "RTP/SAVP"
		for i, suite := range rtp.SRTPSuites {
			material, err := rtp.Generate(suite)
			if err != nil {
				return nil, nil, fmt.Errorf("call: generate SDES material: %w", err)
			}
			tag := i + 1 // tags are 1-indexed by convention
			ourOfferedSDES[tag] = material
			encOffer.CryptoLines = append(encOffer.CryptoLines,
				fmt.Sprintf("%d %s inline:%s",
					tag, suite.Name, material.EncodeInline()))
		}
	}
	return sipx.BuildOffer(rtpSess, m.cfg.MediaIP, encOffer), ourOfferedSDES, nil
}

// dialAndWireRTP performs the SIP-dial + RTP-socket + codec/SRTP
// negotiation shared by every outbound leg (agent originate, consult
// leg, and the agent-less relay leg of a native bridged transfer). It
// returns a partially-built Call: the SIP dialog is up, the RTP socket
// is bound and pointed at the remote endpoint, the payload type and any
// SRTP contexts are set — but there is NO Pipecat WS, NO jitter buffer,
// and the RTP read loop has NOT been started. Callers layer the bits
// they need on top (a bot WS for Originate, peer relay for
// DialAndBridge) and are responsible for rtp.Start + registering the
// Call in m.calls.
//
// On any error after the INVITE is answered, the helper sends a BYE and
// closes the socket itself, so callers only need to propagate the error.
//
// The returned ``custom`` map is the header set actually sent on the
// INVITE (X-Aplisay-Call-Id promoted from metadata), so callers that
// open a WS can stamp the same headers on it.
func (m *Manager) dialAndWireRTP(ctx context.Context, p OriginateParams) (*Call, map[string]string, error) {
	// 1. Allocate the local RTP socket so we can publish our endpoint
	// in the SDP offer.
	rtpSess, err := rtp.NewSession(m.cfg.MediaBindIP, m.cfg.RTPPortMin, m.cfg.RTPPortMax)
	if err != nil {
		return nil, nil, fmt.Errorf("call: rtp: %w", err)
	}

	// Outbound encryption offer. When SRTPOutbound + SRTPEnabled we offer SDES
	// SRTP (RTP/SAVP). ``ourOfferedSDES`` maps tag → master material so we can
	// install the outbound SRTP context once the peer picks a tag in its 200 OK.
	offeringSDES := m.cfg.SRTPEnabled && m.cfg.SRTPOutbound
	offer, ourOfferedSDES, err := m.buildOutboundOffer(rtpSess, offeringSDES)
	if err != nil {
		rtpSess.Close()
		return nil, nil, err
	}

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
	out, _, err := m.sip.Originate(ctx, p.Destination, p.CallerID, offer, custom)
	if err != nil {
		// Some carriers (notably Twilio Elastic SIP Trunks unless explicitly
		// configured for secure media) reject an SRTP offer with 488 Not
		// Acceptable Here. When we offered SRTP and SRTP isn't strictly
		// required, retry once with a plaintext RTP/AVP offer so the call still
		// completes. Trunks that accept SRTP never hit this path, so secure
		// media is preserved everywhere it's supported.
		var se *sipx.SIPResponseError
		if offeringSDES && !m.cfg.SRTPRequired && errors.As(err, &se) && se.Code == 488 {
			log.Warn().
				Str("destination", p.Destination).
				Int("code", se.Code).
				Msg("call: peer rejected SRTP offer (488); retrying with plaintext RTP/AVP")
			offeringSDES = false
			offer, ourOfferedSDES, err = m.buildOutboundOffer(rtpSess, false)
			if err != nil {
				rtpSess.Close()
				return nil, nil, err
			}
			out, _, err = m.sip.Originate(ctx, p.Destination, p.CallerID, offer, custom)
		}
		if err != nil {
			rtpSess.Close()
			return nil, nil, fmt.Errorf("call: originate: %w", err)
		}
	}

	// 3. Wire RTP to the remote endpoint the SDP answer published.
	answer := out.Answer
	if answer.RemoteIP == "" || answer.RemotePort == 0 {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return nil, nil, errors.New("call: SDP answer missing remote endpoint")
	}
	if err := rtpSess.SetRemote(answer.RemoteIP, answer.RemotePort); err != nil {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return nil, nil, fmt.Errorf("call: rtp remote: %w", err)
	}
	pt := rtp.PayloadPCMU
	if !answer.HasPCMU && answer.HasPCMA {
		pt = rtp.PayloadPCMA
	} else if !answer.HasPCMU && !answer.HasPCMA {
		rtpSess.Close()
		_ = m.sip.Hangup(ctx, out.CallID)
		return nil, nil, errors.New("call: no acceptable codec in answer")
	}
	rtpSess.SetPayloadType(pt)

	// If we offered SDES and the peer answered RTP/SAVP, install
	// SRTP contexts. If we offered RTP/AVP, the answer must be AVP
	// too — nothing to install. If we offered RTP/SAVP and the peer
	// answered something else, that's a protocol violation; tear the
	// call down rather than silently fall back to plaintext.
	if offeringSDES {
		inboundCtx, outboundCtx, err := installOutboundSDES(answer, ourOfferedSDES)
		if err != nil {
			rtpSess.Close()
			_ = m.sip.Hangup(ctx, out.CallID)
			return nil, nil, fmt.Errorf("call: outbound SDES negotiation: %w", err)
		}
		if err := rtpSess.SetSRTPContexts(inboundCtx, outboundCtx); err != nil {
			rtpSess.Close()
			_ = m.sip.Hangup(ctx, out.CallID)
			return nil, nil, fmt.Errorf("call: install outbound SRTP contexts: %w", err)
		}
		log.Info().
			Str("call_id", out.CallID).
			Msg("call: outbound SDES negotiated; media encrypted")
	}

	c := &Call{
		callID:  out.CallID,
		rtp:     rtpSess,
		payload: pt,
		closed:  make(chan struct{}),
	}
	c.lastRTPNanos.Store(time.Now().UnixNano())
	return c, custom, nil
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

	// 1-3. Dial + wire RTP/SRTP. On error the helper has already
	// closed the socket and sent BYE if the dialog was up.
	c, custom, err := m.dialAndWireRTP(ctx, p)
	if err != nil {
		return "", err
	}
	c.sessionID = p.AgentSessionID
	c.jb = rtp.NewJitterBuffer(3, 160)

	// 4. Open the Pipecat WS using the session_id supplied by the
	// worker (which is waiting on a future keyed by that id).
	wsURL, err := joinWSPath(m.cfg.WorkerWSBase, "/sipbridge/agent/"+url.PathEscape(p.AgentSessionID))
	if err != nil {
		c.rtp.Close()
		_ = m.sip.Hangup(ctx, c.callID)
		return "", fmt.Errorf("call: ws url: %w", err)
	}

	pc := pcclient.NewClient(wsURL)
	c.ws = pc
	releaseCtx, releaseCancel := context.WithCancel(context.Background())
	c.releaseStop = releaseCancel
	c.startJitterRelease(releaseCtx)
	outCallID := c.callID
	c.startMediaTimeoutWatchdog(m.cfg.RTPTimeoutSeconds, func() {
		_ = m.Hangup(context.Background(), outCallID)
	})

	c.rtp.SetPayloadHandler(c.onRTPPayload)
	pc.SetAudioHandler(c.onWSAudio)
	pc.SetCloseHandler(func(err error) {
		// In relay mode the worker WS is expected to go away (SetPeer
		// stops it, or a monitoring worker restarts) — the bridged
		// call itself must survive until a SIP BYE / media timeout.
		if c.hasPeer() {
			log.Info().Str("call_id", outCallID).Err(err).Msg("call: ws closed while bridged — call stays up")
			return
		}
		log.Info().Str("call_id", outCallID).Err(err).Msg("call: ws closed (outbound)")
		c.Close()
	})

	// Stamp the same headers we sent on the INVITE onto the WS so the
	// worker's lookup chain has them available. The bridge already
	// knows everything the worker needs.
	hdr := http.Header{}
	hdr.Set("X-Sipbridge-Call-ID", c.callID)
	for k, v := range custom {
		hdr.Set(k, v)
	}

	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pc.Connect(dctx, hdr); err != nil {
		c.rtp.Close()
		_ = m.sip.Hangup(ctx, c.callID)
		return "", fmt.Errorf("call: pipecat ws connect: %w", err)
	}

	c.rtp.Start(context.Background())

	m.mu.Lock()
	m.calls[c.callID] = c
	m.mu.Unlock()

	log.Info().
		Str("call_id", c.callID).
		Str("session_id", p.AgentSessionID).
		Str("ws_url", wsURL).
		Int("rtp_port", c.rtp.LocalAddr().Port).
		Msg("call: outbound ready")
	return c.callID, nil
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
//   - mode "attended": ``target`` is interpreted as a second call_id
//     (a consult leg). Instead of bridging media, the bridge REFERs the
//     original caller to the consult target with ``?Replaces`` pointing
//     at the consult dialog (RFC 3891). The caller re-INVITEs the consult
//     target directly and the bridge drops out of the media path. This is
//     the SIP-REFER finalisation of a consultative transfer — see
//     ``docs/call-transfers.md``.
//   - mode "consult": invalid for the transfer endpoint — clients
//     should call the dedicated /v1/calls/{id}/consult endpoint.
// ``opts`` applies to mode "bridged" only — see BridgeOptions.
func (m *Manager) Transfer(ctx context.Context, callID, target, mode string, opts BridgeOptions) error {
	if m.sip == nil {
		return errors.New("call: SIP layer not registered")
	}
	switch mode {
	case "", "blind":
		return m.sip.Refer(ctx, callID, target)
	case "bridged":
		return m.BridgeRelay(callID, target, opts)
	case "attended":
		return m.sip.ReferReplaces(ctx, callID, target)
	case "consult":
		return errors.New("call: use /v1/calls/{id}/consult endpoint for consult, not /transfer")
	default:
		return fmt.Errorf("call: unknown transfer mode %q", mode)
	}
}

// BridgeOptions tune a media-relay bridge (modes "bridged" and
// "dial_bridge"):
//
//   - MonitorDTMF keeps the original (A) leg's worker WS open as a
//     control channel and surfaces transfer-target DTMF presses on it
//     (options.bridgedTransferToAgent).
//   - TapAudio additionally streams a decoded stereo copy of both legs
//     (L = caller, R = target) on the same kept-open WS for
//     transcription (options.bridgedTransferTranscribe). See tap.go.
//
// Either flag keeps the A leg's WS open.
type BridgeOptions struct {
	MonitorDTMF bool
	TapAudio    bool
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
// ``opts.MonitorDTMF`` marks the A leg (the original caller) as the
// monitoring side: its worker WS is kept open (control-only) and
// receives ``source: "transfer_target"`` DTMF events detected on the
// B leg, so the worker can drive a bridged transfer-to-agent.
// ``opts.TapAudio`` additionally arms the stereo transcription tap on
// the same WS (see tap.go).
func (m *Manager) BridgeRelay(callA, callB string, opts BridgeOptions) error {
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
	keepWS := opts.MonitorDTMF || opts.TapAudio
	a.mu.Lock()
	a.dtmfMonitor = opts.MonitorDTMF
	a.mu.Unlock()
	if opts.TapAudio && a.ws != nil {
		mixer := newTapMixer(a.ws)
		a.mu.Lock()
		a.tap = mixer
		a.tapSide = tapSideCaller
		a.mu.Unlock()
		b.mu.Lock()
		b.tap = mixer
		b.tapSide = tapSideTarget
		b.mu.Unlock()
	}
	a.SetPeer(b, keepWS)
	b.SetPeer(a, false)
	log.Info().
		Str("call_a", callA).
		Str("call_b", callB).
		Bool("monitor_dtmf", opts.MonitorDTMF).
		Bool("tap_audio", opts.TapAudio).
		Msg("call: media relay installed (bridged transfer)")
	return nil
}

// DialBridgeParams carries the body of a native blind-bridged transfer:
// dial ``Destination`` as a fresh agent-less leg and relay its media
// to ``OriginalCallID``. Unlike Consult, the new leg has no Pipecat WS
// — it exists purely as the far end of an in-Go RTP relay.
type DialBridgeParams struct {
	OriginalCallID string
	Destination    string
	CallerID       string
	CustomHeaders  map[string]string
	Metadata       map[string]string
	// Bridge monitoring/tap flags — see BridgeOptions.
	Options BridgeOptions
}

// DialAndBridge is the native (non-REFER) blind bridged transfer: it
// dials ``Destination`` as a new outbound leg with NO agent attached,
// then installs an in-process RTP relay between the original caller and
// that new leg. The agent bot on the original leg drops out of the
// media path (its Pipecat WS is closed by SetPeer) and the bridge
// becomes a transparent B2BUA forwarding G.711 between the two dialogs.
// Media stays inside the bridge — no carrier REFER is involved — so it
// works on trunks/registrations that don't honour REFER.
//
// Returns the new leg's call_id (for diagnostics / later teardown). On
// any failure after the leg answers, the new leg is torn down so we
// don't leak a half-bridged dialog.
func (m *Manager) DialAndBridge(ctx context.Context, p DialBridgeParams) (string, error) {
	if m.sip == nil {
		return "", errors.New("call: SIP layer not registered")
	}
	// The original must still be live — we relay into it.
	m.mu.Lock()
	_, ok := m.calls[p.OriginalCallID]
	m.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("call: dial_bridge: unknown original call_id %q", p.OriginalCallID)
	}

	// Dial the target. The relay leg is agent-less: no Pipecat WS and
	// no jitter buffer — onRTPPayload forwards straight to the peer
	// once SetPeer engages (which BridgeRelay does below).
	c, _, err := m.dialAndWireRTP(ctx, OriginateParams{
		Destination:   p.Destination,
		CallerID:      p.CallerID,
		CustomHeaders: p.CustomHeaders,
		Metadata:      p.Metadata,
	})
	if err != nil {
		return "", fmt.Errorf("call: dial_bridge: %w", err)
	}

	newID := c.callID
	c.startMediaTimeoutWatchdog(m.cfg.RTPTimeoutSeconds, func() {
		_ = m.Hangup(context.Background(), newID)
	})
	c.rtp.SetPayloadHandler(c.onRTPPayload)
	c.rtp.Start(context.Background())

	m.mu.Lock()
	m.calls[newID] = c
	m.mu.Unlock()

	// Install the relay. BridgeRelay closes the original leg's bot WS
	// (SetPeer) so the agent drops out — unless MonitorDTMF/TapAudio
	// keep it open as a control channel; the new leg never had one.
	if err := m.BridgeRelay(p.OriginalCallID, newID, p.Options); err != nil {
		// Codec mismatch or the original vanished — tear the new leg
		// down (SIP BYE + media close) so we don't leak it.
		_ = m.Hangup(context.Background(), newID)
		return "", fmt.Errorf("call: dial_bridge: %w", err)
	}
	log.Info().
		Str("original", p.OriginalCallID).
		Str("relay_leg", newID).
		Str("destination", p.Destination).
		Msg("call: native blind bridged transfer established")
	return newID, nil
}

// UnbridgeParams carries the body of POST /v1/calls/{id}/unbridge: tear
// the media relay down, hang up the peer (transfer-target) leg, and
// re-attach the surviving leg to a fresh worker agent WS session so a
// new bot pipeline can take the caller over. This is the finalise step
// of a bridged transfer-to-agent (options.bridgedTransferToAgent).
type UnbridgeParams struct {
	CallID           string
	AgentSessionID   string
	CustomHeaders    map[string]string
}

// Unbridge reverses a bridged transfer on the monitoring leg: the peer
// leg is BYE'd, the relay is dismantled, and the leg is re-wired into
// ordinary Pipecat-bot mode with a NEW worker WS (dialled to
// /sipbridge/agent/{AgentSessionID}, which the worker pre-registered).
// The old control-only monitor WS, if still up, is closed first.
//
// On WS dial failure the whole call is torn down — the target is
// already gone by then and an agent-less silent leg helps nobody — and
// the error is returned so the worker can mark the takeover failed.
func (m *Manager) Unbridge(ctx context.Context, p UnbridgeParams) error {
	if p.AgentSessionID == "" {
		return errors.New("call: unbridge: AgentSessionID is required")
	}
	m.mu.Lock()
	c, ok := m.calls[p.CallID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("call: unbridge: unknown call_id %q", p.CallID)
	}
	c.mu.Lock()
	peer := c.peer
	c.mu.Unlock()
	if peer == nil {
		return fmt.Errorf("call: unbridge: call %q is not bridged", p.CallID)
	}

	// 1. Retire the old monitor WS while the relay guard (hasPeer) is
	// still active, so its close handler doesn't tear the call down.
	if old := c.ws; old != nil {
		old.Stop()
		select {
		case <-old.Done():
		case <-time.After(2 * time.Second):
			log.Warn().Str("call_id", c.callID).Msg("call: unbridge: old ws slow to close; continuing")
		}
	}

	// 2. Dismantle the relay BEFORE hanging the peer up so no packet
	// forwards into a closing RTP session (which would Close us too).
	c.ClearPeer()
	peer.ClearPeer()
	if err := m.Hangup(ctx, peer.callID); err != nil {
		log.Warn().Err(err).Str("call_id", peer.callID).Msg("call: unbridge: peer hangup failed (continuing)")
	}

	// 3. Re-attach a fresh bot WS, exactly like an originate. The worker
	// chose the session id and is already waiting on it.
	wsURL, err := joinWSPath(m.cfg.WorkerWSBase, "/sipbridge/agent/"+url.PathEscape(p.AgentSessionID))
	if err != nil {
		_ = m.Hangup(context.Background(), c.callID)
		return fmt.Errorf("call: unbridge: ws url: %w", err)
	}
	pc := pcclient.NewClient(wsURL)
	unbridgedID := c.callID
	pc.SetAudioHandler(c.onWSAudio)
	pc.SetCloseHandler(func(err error) {
		if c.hasPeer() {
			log.Info().Str("call_id", unbridgedID).Err(err).Msg("call: ws closed while bridged — call stays up")
			return
		}
		log.Info().Str("call_id", unbridgedID).Err(err).Msg("call: ws closed (post-unbridge)")
		c.Close()
	})
	hdr := http.Header{}
	hdr.Set("X-Sipbridge-Call-ID", c.callID)
	for k, v := range p.CustomHeaders {
		hdr.Set(k, v)
	}
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pc.Connect(dctx, hdr); err != nil {
		_ = m.Hangup(context.Background(), c.callID)
		return fmt.Errorf("call: unbridge: pipecat ws connect: %w", err)
	}

	// 4. Swap the WS in and restart the decode path (jitter buffer +
	// release loop) that SetPeer stopped when the relay engaged.
	c.mu.Lock()
	c.ws = pc
	c.sessionID = p.AgentSessionID
	if c.jb == nil {
		c.jb = rtp.NewJitterBuffer(3, 160)
	} else {
		c.jb.Reset()
	}
	c.mu.Unlock()
	releaseCtx, releaseCancel := context.WithCancel(context.Background())
	c.releaseStop = releaseCancel
	c.startJitterRelease(releaseCtx)

	log.Info().
		Str("call_id", c.callID).
		Str("session_id", p.AgentSessionID).
		Str("dropped_peer", peer.callID).
		Msg("call: unbridged — agent re-attached")
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

	// 2a. Negotiate SRTP — picks plaintext / SDES / DTLS-SRTP based on
	// the offer + our policy. Returns a *sipx.RejectError mapped to a
	// SIP rejection code if policy demands encrypted and the peer
	// offered plaintext.
	neg, err := m.negotiateSRTP(offer)
	if err != nil {
		rtpSess.Close()
		return nil, err
	}
	// 2b. For SDES the contexts can be installed immediately. For
	// DTLS-SRTP they get installed asynchronously in step 7 once the
	// handshake completes.
	if neg.InboundCtx != nil || neg.OutboundCtx != nil {
		if err := rtpSess.SetSRTPContexts(neg.InboundCtx, neg.OutboundCtx); err != nil {
			rtpSess.Close()
			return nil, fmt.Errorf("call: install SRTP contexts: %w", err)
		}
	}
	// 2c. Build SDP answer + decide codec.
	answer, pt, err := sipx.BuildAnswer(offer, rtpSess, m.cfg.MediaIP, neg.Params)
	if err != nil {
		rtpSess.Close()
		return nil, fmt.Errorf("call: sdp answer: %w", err)
	}
	rtpSess.SetPayloadType(pt)
	log.Info().
		Str("call_id", callID).
		Str("encryption", neg.Mode).
		Msg("call: encryption negotiated")

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
	c.lastRTPNanos.Store(time.Now().UnixNano())
	releaseCtx, releaseCancel := context.WithCancel(context.Background())
	c.releaseStop = releaseCancel
	c.startJitterRelease(releaseCtx)
	inCallID := callID
	c.startMediaTimeoutWatchdog(m.cfg.RTPTimeoutSeconds, func() {
		_ = m.Hangup(context.Background(), inCallID)
	})

	// 4. Wire callbacks. Both directions go through the codec layer.
	rtpSess.SetPayloadHandler(c.onRTPPayload)
	pc.SetAudioHandler(c.onWSAudio)
	pc.SetCloseHandler(func(err error) {
		// See the outbound handler: a bridged call must survive its
		// worker WS going away (SetPeer stop or monitor-worker loss).
		if c.hasPeer() {
			log.Info().Str("call_id", callID).Err(err).Msg("call: ws closed while bridged — call stays up")
			return
		}
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
		return nil, mapWSDialErrorToReject(err)
	}

	// 5b. Brief wait for an early WS close — covers the fallback path
	// in the worker where it can't use the ASGI denial-response
	// extension and instead accepts the upgrade then closes immediately
	// with a 4xxx close code encoding the SIP rejection status. Without
	// this we'd return SDP/200 OK to the upstream B2BUA before the
	// close frame arrived and the call would be "answered" only to BYE
	// instantly. 300ms is enough for any in-process synchronous
	// rejection (the worker's resolver returns within ~ms on a 404);
	// real audio start-up is much slower so we don't risk false
	// positives here.
	if pc.WaitForEarlyClose(300 * time.Millisecond) {
		rtpSess.Close()
		return nil, mapEarlyCloseToReject(pc.CloseErr())
	}

	// 6. Spawn the RTP read goroutine. For plaintext / SDES the
	// session can start immediately. For DTLS-SRTP the readLoop has
	// to stay parked until the handshake completes on the same UDP
	// socket — kick the handshake off in a goroutine, it will call
	// Start when it's done (and Close on failure).
	if neg.Finalize != nil {
		go func() {
			fctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := neg.Finalize(fctx, rtpSess); err != nil {
				log.Error().
					Err(err).
					Str("call_id", callID).
					Msg("call: DTLS-SRTP handshake failed; tearing call down")
				_ = m.Hangup(context.Background(), callID)
				return
			}
			rtpSess.Start(context.Background())
			log.Info().
				Str("call_id", callID).
				Msg("call: DTLS-SRTP handshake complete; media flowing")
		}()
	} else {
		rtpSess.Start(context.Background())
	}

	m.mu.Lock()
	m.calls[callID] = c
	m.mu.Unlock()

	log.Info().
		Str("call_id", callID).
		Str("session_id", sessionID).
		Str("ws_url", wsURL).
		Int("rtp_port", rtpSess.LocalAddr().Port).
		Bool("encrypted", neg.Mode != "plaintext").
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
		log.Info().Str("call_id", callID).Msg("call: tearing down (BYE)")
		// A bridged pair lives and dies together: when one side BYEs,
		// hang the peer leg up too (BYE + media close) rather than
		// leaving it to leak until the dialog/media timeout.
		c.mu.Lock()
		peer := c.peer
		c.peer = nil
		c.mu.Unlock()
		c.Close()
		if peer != nil {
			peer.ClearPeer()
			_ = m.Hangup(context.Background(), peer.callID)
		}
	} else {
		log.Warn().Str("call_id", callID).Msg("call: onBye for unknown call — already torn down or never registered")
	}
}

// mapWSDialErrorToReject converts a Pipecat WS dial failure into a
// ``*sipx.RejectError`` carrying an appropriate SIP response code. The
// worker rejects the WS upgrade with an HTTP status that maps to the
// SIP status the upstream B2BUA / carrier should see; if we can't
// recover the HTTP status (TCP refused, DNS, TLS handshake, …) we
// default to SIP 503 — "the worker is unavailable, try later".
//
// HTTP → SIP mapping table:
//
//	worker HTTP        SIP                why
//	-----------------  -----------------  -----------------------------
//	404 Not Found      404 Not Found      no agent for dialled number
//	403 Forbidden      403 Forbidden      auth/policy refusal
//	401 Unauthorized   401 Unauthorized   missing/bad auth on REST
//	429 Too Many       503 Service Unav.  worker-level rate limit
//	5xx                500 Server Error   worker bug / dep down
//	other 4xx          488 Not Accept.    catch-all SIP "no, but client-side"
//	no response (0)    503 Service Unav.  worker process down / unreachable
//
// SIP doesn't have a direct equivalent for every HTTP status — 488 Not
// Acceptable Here is the conventional SIP catch-all for "your request
// is malformed in a way the server can articulate", which is the
// closest analogue to a generic 4xx from the worker.
func mapWSDialErrorToReject(err error) error {
	var de *pcclient.DialError
	if !errors.As(err, &de) {
		// Not a dial error — treat as generic server-side failure.
		return &sipx.RejectError{
			SIPCode: 500,
			Reason:  "Server Error",
			Cause:   err,
		}
	}
	switch de.HTTPStatus {
	case 0:
		return &sipx.RejectError{
			SIPCode: 503,
			Reason:  "Service Unavailable",
			Cause:   err,
		}
	case http.StatusNotFound:
		return &sipx.RejectError{
			SIPCode: 404,
			Reason:  "Not Found",
			Cause:   err,
		}
	case http.StatusUnauthorized:
		return &sipx.RejectError{
			SIPCode: 401,
			Reason:  "Unauthorized",
			Cause:   err,
		}
	case http.StatusForbidden:
		return &sipx.RejectError{
			SIPCode: 403,
			Reason:  "Forbidden",
			Cause:   err,
		}
	case http.StatusTooManyRequests:
		return &sipx.RejectError{
			SIPCode: 503,
			Reason:  "Service Unavailable",
			Cause:   err,
		}
	}
	if de.HTTPStatus >= 500 {
		return &sipx.RejectError{
			SIPCode: 500,
			Reason:  "Server Error",
			Cause:   err,
		}
	}
	if de.HTTPStatus >= 400 {
		return &sipx.RejectError{
			SIPCode: 488,
			Reason:  "Not Acceptable Here",
			Cause:   err,
		}
	}
	// 1xx/2xx/3xx leaked through — shouldn't happen since coder/websocket
	// only errors on non-101; treat as a server error so we don't accept
	// the SIP transaction with a healthy code while the WS path is broken.
	return &sipx.RejectError{
		SIPCode: 500,
		Reason:  "Server Error",
		Cause:   err,
	}
}

// negotiatedSRTP carries the result of negotiating encrypted media
// from an inbound SDP offer. The Manager.onInvite path uses it to
// (a) populate sipx.EncryptionParams for BuildAnswer and (b) install
// the matching SRTP contexts on the rtp.Session.
//
// For SDES the contexts can be installed immediately — both sides'
// keying material is in the SDP. For DTLS-SRTP the contexts are nil
// at negotiation time and a Finalize callback is set; the call
// manager calls Finalize after the DTLS handshake completes (on a
// background goroutine; the SIP transaction is answered synchronously
// with the SDP, the keys arrive shortly after).
type negotiatedSRTP struct {
	// Encryption params for the SDP answer.
	Params sipx.EncryptionParams
	// SRTP contexts to install on the rtp.Session for SDES. Nil for
	// DTLS-SRTP — those get installed via Finalize.
	InboundCtx, OutboundCtx *srtpv3.Context
	// Finalize runs the DTLS-SRTP handshake on the rtp.Session's
	// socket, derives the per-direction master keys from the keying-
	// material export, and installs SRTP contexts. nil for SDES /
	// plaintext.
	Finalize func(ctx context.Context, rtpSess *rtp.Session) error
	// Mode is "plaintext" | "sdes" | "dtls-srtp" — used for logging.
	Mode string
}

// negotiateSRTP picks the encryption path based on the peer's offered
// MediaProfile and the bridge's policy. Returns a *sipx.RejectError
// when SRTPRequired is set and the peer offered plaintext only — the
// SIP layer translates that into a 488 Not Acceptable Here.
func (m *Manager) negotiateSRTP(offer *sipx.CodecOffer) (*negotiatedSRTP, error) {
	// 1. Identify what the peer wants from MediaProfile.
	profile := offer.MediaProfile
	wantsSDES := profile == "RTP/SAVP" || profile == "RTP/SAVPF"
	wantsDTLS := profile == "UDP/TLS/RTP/SAVP" || profile == "UDP/TLS/RTP/SAVPF"
	wantsPlain := !wantsSDES && !wantsDTLS // including "RTP/AVP", "RTP/AVPF", or empty

	if !m.cfg.SRTPEnabled {
		if wantsPlain {
			return &negotiatedSRTP{Mode: "plaintext"}, nil
		}
		// Peer wants encryption, we have it off. Don't try to "downgrade
		// to plaintext" — that would silently weaken security guarantees
		// the peer is relying on. Reject so the operator sees it.
		return nil, &sipx.RejectError{
			SIPCode: 488,
			Reason:  "Not Acceptable Here",
			Cause:   fmt.Errorf("peer offered %q but SRTPEnabled=false", profile),
		}
	}
	if wantsPlain {
		if m.cfg.SRTPRequired {
			return nil, &sipx.RejectError{
				SIPCode: 488,
				Reason:  "Not Acceptable Here",
				Cause:   fmt.Errorf("SRTPRequired but peer offered plaintext %q", profile),
			}
		}
		return &negotiatedSRTP{Mode: "plaintext"}, nil
	}

	if wantsSDES {
		return m.negotiateSDES(offer, profile)
	}
	if wantsDTLS {
		if !m.cfg.SRTPDTLSEnabled || m.cfg.DTLSCert == nil {
			return nil, &sipx.RejectError{
				SIPCode: 488,
				Reason:  "Not Acceptable Here",
				Cause:   fmt.Errorf("peer offered DTLS-SRTP but SRTPDTLSEnabled=false or no cert configured"),
			}
		}
		return m.negotiateDTLSSRTP(offer, profile)
	}
	// Shouldn't reach here — the wantsPlain branch above covers all
	// non-SAVP profiles — but defend in depth.
	return nil, &sipx.RejectError{
		SIPCode: 488,
		Reason:  "Not Acceptable Here",
		Cause:   fmt.Errorf("unsupported media profile %q", profile),
	}
}

// negotiateSDES is the inbound SDES path: pick a suite both sides
// support, decode the peer's master key+salt, generate ours, build the
// SRTP contexts, and emit the matching ``a=crypto`` line for our
// answer.
func (m *Manager) negotiateSDES(offer *sipx.CodecOffer, profile string) (*negotiatedSRTP, error) {
	if len(offer.CryptoOffers) == 0 {
		return nil, &sipx.RejectError{
			SIPCode: 488,
			Reason:  "Not Acceptable Here",
			Cause:   errors.New("SAVP profile but no a=crypto attributes"),
		}
	}
	// Walk peer's offers in their preference order; pick first one we
	// support. RFC 4568 says the answerer picks one of the offered
	// attributes; we don't get to substitute a different suite.
	var chosen sipx.CryptoAttr
	var chosenSuite rtp.SRTPSuite
	for _, ca := range offer.CryptoOffers {
		s, ok := rtp.SuiteByName(ca.Suite)
		if !ok {
			continue
		}
		chosen = ca
		chosenSuite = s
		break
	}
	if chosenSuite.Name == "" {
		return nil, &sipx.RejectError{
			SIPCode: 488,
			Reason:  "Not Acceptable Here",
			Cause:   fmt.Errorf("no SDES suite in common (peer offered %d suite(s))", len(offer.CryptoOffers)),
		}
	}
	// Decode peer's keying material (inbound key for us = peer's master).
	peerMaterial, err := rtp.DecodeInline(chosenSuite, chosen.Inline)
	if err != nil {
		return nil, &sipx.RejectError{
			SIPCode: 488,
			Reason:  "Not Acceptable Here",
			Cause:   fmt.Errorf("decode peer crypto: %w", err),
		}
	}
	// Generate our own material for the outbound direction.
	ourMaterial, err := rtp.Generate(chosenSuite)
	if err != nil {
		return nil, fmt.Errorf("generate SDES material: %w", err) // bubble as 500
	}
	inboundCtx, err := peerMaterial.Context()
	if err != nil {
		return nil, fmt.Errorf("build inbound SRTP context: %w", err)
	}
	outboundCtx, err := ourMaterial.Context()
	if err != nil {
		return nil, fmt.Errorf("build outbound SRTP context: %w", err)
	}
	cryptoLine := fmt.Sprintf("%d %s inline:%s",
		chosen.Tag, chosenSuite.Name, ourMaterial.EncodeInline())
	return &negotiatedSRTP{
		Mode: "sdes",
		Params: sipx.EncryptionParams{
			Profile:     profile, // echo whatever they offered (RTP/SAVP or RTP/SAVPF)
			CryptoLines: []string{cryptoLine},
		},
		InboundCtx:  inboundCtx,
		OutboundCtx: outboundCtx,
	}, nil
}

// negotiateDTLSSRTP is the inbound DTLS-SRTP path: pick our setup role,
// stamp our cert fingerprint in the answer, defer the actual handshake
// + key derivation to Finalize. The handshake can't run synchronously
// because the peer won't send DTLS packets until they've received our
// SDP answer.
func (m *Manager) negotiateDTLSSRTP(offer *sipx.CodecOffer, profile string) (*negotiatedSRTP, error) {
	if m.cfg.DTLSFingerprint == "" {
		return nil, fmt.Errorf("DTLS-SRTP: no fingerprint configured on manager")
	}
	if offer.Fingerprint.IsZero() {
		return nil, &sipx.RejectError{
			SIPCode: 488,
			Reason:  "Not Acceptable Here",
			Cause:   errors.New("DTLS-SRTP profile but no a=fingerprint"),
		}
	}
	// RFC 5763 §5: answer picks "passive" if offer is "actpass" / "active",
	// "active" if offer is "passive". Default offer is "actpass".
	ourRole := "passive"
	switch offer.Setup {
	case "active":
		ourRole = "passive"
	case "passive":
		ourRole = "active"
	case "actpass", "":
		ourRole = "passive"
	case "holdconn":
		return nil, &sipx.RejectError{
			SIPCode: 488, Reason: "Not Acceptable Here",
			Cause: errors.New("DTLS-SRTP a=setup:holdconn not supported"),
		}
	}
	// Finalize runs after the SIP 200 OK. Implemented in dtls.go
	// (Task 8) — for now stash the inputs so the handshake routine
	// has what it needs.
	peerFingerprint := offer.Fingerprint
	cert := m.cfg.DTLSCert
	isClient := ourRole == "active"
	finalize := func(ctx context.Context, rtpSess *rtp.Session) error {
		return rtp.RunDTLSSRTPHandshake(
			ctx, rtpSess, cert,
			peerFingerprint.Algorithm, peerFingerprint.Hex,
			isClient,
		)
	}
	return &negotiatedSRTP{
		Mode: "dtls-srtp",
		Params: sipx.EncryptionParams{
			Profile:     profile,
			Fingerprint: m.cfg.DTLSFingerprint,
			SetupRole:   ourRole,
		},
		Finalize: finalize,
	}, nil
}

// installOutboundSDES finishes the outbound SDES handshake: given the
// peer's 200 OK answer and the master keys we offered (indexed by tag),
// it figures out which suite they accepted and builds inbound + outbound
// SRTP contexts.
//
//   - peer answers RTP/AVP (plaintext) when we offered SAVP → protocol
//     violation per RFC 3264 §6.1 (answer profile must match offer),
//     reject.
//   - peer answers RTP/SAVP with no a=crypto → also a violation, reject.
//   - peer answers with a tag we didn't offer → reject; can't decode.
//   - peer answers with our offered tag — use their inline as the
//     decrypt key, our offered material as the encrypt key.
func installOutboundSDES(
	answer *sipx.CodecOffer,
	offered map[int]rtp.CryptoMaterial,
) (*srtpv3.Context, *srtpv3.Context, error) {
	profile := answer.MediaProfile
	if profile != "RTP/SAVP" && profile != "RTP/SAVPF" {
		return nil, nil, fmt.Errorf("we offered SAVP but peer answered %q", profile)
	}
	if len(answer.CryptoOffers) == 0 {
		return nil, nil, errors.New("peer answered SAVP but provided no a=crypto")
	}
	// Answer carries exactly one a=crypto (the suite they picked). If
	// they sent more, take the first.
	picked := answer.CryptoOffers[0]
	ourMaterial, ok := offered[picked.Tag]
	if !ok {
		return nil, nil, fmt.Errorf("peer picked tag %d which we didn't offer", picked.Tag)
	}
	// Their suite name must match the suite for the tag we offered;
	// RFC 4568 §5.1.2 says the answerer MUST use a suite from the offer.
	if !strings.EqualFold(picked.Suite, ourMaterial.Suite.Name) {
		return nil, nil, fmt.Errorf("peer picked tag %d but with suite %q (we offered %q for that tag)",
			picked.Tag, picked.Suite, ourMaterial.Suite.Name)
	}
	peerMaterial, err := rtp.DecodeInline(ourMaterial.Suite, picked.Inline)
	if err != nil {
		return nil, nil, fmt.Errorf("decode peer crypto: %w", err)
	}
	inboundCtx, err := peerMaterial.Context()
	if err != nil {
		return nil, nil, fmt.Errorf("build inbound SRTP context: %w", err)
	}
	outboundCtx, err := ourMaterial.Context()
	if err != nil {
		return nil, nil, fmt.Errorf("build outbound SRTP context: %w", err)
	}
	return inboundCtx, outboundCtx, nil
}

// mapEarlyCloseToReject converts a WS close frame that arrived
// immediately after the upgrade into a ``*sipx.RejectError`` carrying
// the SIP response code the worker meant to signal. Used on the
// fallback path where the worker accepted the upgrade and then closed
// — the close code in the private-use range (4xxx) encodes the SIP
// status as ``4000 + sip_status`` (4404 → SIP 404, 4503 → SIP 503).
//
// Anything outside the 4xxx range — including the generic 1011
// StatusInternalError that older Pipecat worker builds emitted — is
// treated as a server-side failure and mapped to SIP 500.
func mapEarlyCloseToReject(err error) error {
	code := websocket.CloseStatus(err)
	if code >= 4000 && code <= 4999 {
		sipCode := int(code) - 4000
		if sipCode < 300 || sipCode > 699 {
			// Out-of-SIP-range code — fall through to 500.
			return &sipx.RejectError{
				SIPCode: 500,
				Reason:  "Server Error",
				Cause:   err,
			}
		}
		return &sipx.RejectError{
			SIPCode: sipCode,
			Reason:  sipReasonFor(sipCode),
			Cause:   err,
		}
	}
	// Non-private-use or no close code present → server error.
	return &sipx.RejectError{
		SIPCode: 500,
		Reason:  "Server Error",
		Cause:   err,
	}
}

// sipReasonFor returns the canonical SIP reason phrase for a status
// code. Covers the rejection codes we map to from worker failures; any
// unrecognised code falls back to "Server Error".
func sipReasonFor(code int) string {
	switch code {
	case 401:
		return "Unauthorized"
	case 403:
		return "Forbidden"
	case 404:
		return "Not Found"
	case 486:
		return "Busy Here"
	case 488:
		return "Not Acceptable Here"
	case 500:
		return "Server Error"
	case 503:
		return "Service Unavailable"
	}
	return "Server Error"
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

	// dtmfMonitor marks this leg as the DTMF-monitoring side of a
	// bridged transfer (options.bridgedTransferToAgent). While true and
	// in relay mode, the leg's Pipecat WS is kept open as a control-only
	// channel: no audio frames flow, but RFC 4733 end-of-event presses
	// detected on the PEER (transfer-target) leg are surfaced to the
	// worker as ``{"type":"dtmf",...,"source":"transfer_target"}``
	// MessageFrames so it can trigger an unbridge + agent re-attach.
	dtmfMonitor bool

	// lastMonitorDTMF dedupes RFC 4733 end-of-event retransmissions on
	// the monitor path (senders repeat the final report ~3 times for
	// loss resilience; each repeat carries the same symbol + duration).
	// Guarded by mu.
	lastMonitorDTMF struct {
		sym      byte
		duration uint16
		atNanos  int64
	}

	// tap / tapSide: transcription tap for a bridged transfer
	// (``tap_audio`` — options.bridgedTransferTranscribe). Both legs of
	// the bridge share ONE tapMixer, owned by the monitoring leg's
	// kept-open WS; each leg pushes its own decoded inbound audio to its
	// side (caller = left, target = right). Guarded by mu. See tap.go.
	tap     *tapMixer
	tapSide int

	// firstRTPLogged: once-flag that gates the "first RTP packet
	// received" diagnostic log. Useful to confirm whether the upstream
	// is actually sending media to the port we advertised in the SDP
	// answer — especially in dev when only a sub-range of RTP ports
	// is forwarded through Docker Desktop / a corporate firewall.
	firstRTPLogged atomic.Bool

	// lastRTPNanos is the time.UnixNano() of the most recent inbound
	// RTP packet. Updated atomically on every payload. The media-
	// timeout watchdog compares it against time.Now() to detect peers
	// that have stopped sending media without sending a BYE — most
	// famously Twilio's Elastic SIP Trunk, which simply ceases media
	// when the caller hangs up.
	//
	// Initialised at Call construction to time.Now().UnixNano() so the
	// watchdog gives an equal grace period for media to start as it
	// does for media to stop.
	lastRTPNanos atomic.Int64

	// mediaTimeoutStop cancels the media-timeout watchdog. Set when
	// the watchdog goroutine is started; nil-safe (Close handles
	// both states).
	mediaTimeoutStop context.CancelFunc
}

// SendDTMF plays a string of DTMF digits to the far end of this call as
// out-of-band RFC 4733 telephone-event RTP on the call's own SSRC. Blocks
// for the burst duration; returns a write error if the session is gone.
func (c *Call) SendDTMF(ctx context.Context, digits string) error {
	if c.rtp == nil {
		return fmt.Errorf("call: %s has no RTP session", c.callID)
	}
	return c.rtp.SendTelephoneEvent(ctx, digits)
}

// SetPeer puts the call into media-relay mode by stapling it to its
// peer. The other side of the bridge must call SetPeer with this one
// before the audio path becomes fully duplex.
//
// SetPeer is idempotent and may be called once per call. After SetPeer
// the call's `ws` is normally closed — the worker no longer
// participates in audio — and the jitter-buffer release loop is
// stopped since the relay path forwards packets immediately without
// reordering. With ``keepWS`` (DTMF-monitored bridges) the WS is left
// open as a control-only channel: the release loop still stops, so no
// audio frames flow, but peer-leg DTMF events can be delivered on it.
func (c *Call) SetPeer(peer *Call, keepWS bool) {
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
	if c.ws != nil && !keepWS {
		c.ws.Stop()
	}
}

// ClearPeer takes the call back out of media-relay mode (the unbridge
// path). The caller is responsible for re-attaching a worker WS and
// restarting the jitter-release loop — see Manager.Unbridge.
func (c *Call) ClearPeer() {
	c.mu.Lock()
	c.peer = nil
	c.dtmfMonitor = false
	tap := c.tap
	c.tap = nil
	c.mu.Unlock()
	if tap != nil {
		tap.Stop()
	}
}

// hasPeer reports whether the call is currently in media-relay mode.
func (c *Call) hasPeer() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.peer != nil
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
	// Refresh the last-RTP timestamp on every packet — the media-
	// timeout watchdog reads this to detect peers that stop sending
	// media without sending BYE.
	c.lastRTPNanos.Store(time.Now().UnixNano())
	// First-packet diagnostic. Swap returns the prior value, so the
	// log fires exactly once per call regardless of how many packets
	// race in concurrently. Useful when investigating "no inbound
	// audio" issues — confirms RTP is actually arriving at the bound
	// port (rather than e.g. being dropped by a firewall / missing
	// port-forward).
	if c.firstRTPLogged.CompareAndSwap(false, true) {
		log.Info().
			Str("call_id", c.callID).
			Uint8("payload_type", uint8(pt)).
			Int("payload_bytes", len(payload)).
			Uint16("first_seq", seq).
			Int("rtp_port", c.rtp.LocalAddr().Port).
			Bool("encrypted", c.rtp.IsEncrypted()).
			Msg("rtp: first inbound packet received")
	}
	c.mu.Lock()
	peer := c.peer
	c.mu.Unlock()
	if peer != nil {
		if pt == rtp.PayloadDTMF {
			// Never forward RFC 4733 packets across the relay —
			// SendPayload would re-stamp them with the audio payload
			// type and the far end would hear a noise blip instead of
			// a keypress. If the peer leg is monitoring (bridged
			// transfer-to-agent), surface the press to its worker WS.
			peer.maybeEmitPeerDTMF(c.callID, payload)
			return
		}
		if err := peer.rtp.SendPayload(payload); err != nil {
			log.Warn().Err(err).
				Str("from", c.callID).
				Str("to", peer.callID).
				Msg("call: relay forward failed")
			c.Close()
			return
		}
		// Transcription tap (tap_audio): push a decoded COPY of this
		// leg's audio to its side of the shared mixer. Purely additive —
		// the relay write above has already happened.
		c.mu.Lock()
		tap := c.tap
		side := c.tapSide
		c.mu.Unlock()
		if tap != nil {
			if samples := c.decode16k(payload); samples != nil {
				tap.push(side, samples)
			}
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
// JSON describing the press:
// ``{"type":"dtmf","digit":"5","duration_ms":120,"call_id":"..."}``.
// The worker's DtmfProtobufFrameSerializer turns this into a Pipecat
// InputDTMFFrame.
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

// maybeEmitPeerDTMF is called on the MONITORING leg of a DTMF-monitored
// bridge when an RFC 4733 packet arrives on its peer (the transfer
// target). On the end-of-event packet it ships a MessageFrame to the
// monitoring leg's still-open worker WS:
// ``{"type":"dtmf","digit":"5","duration_ms":120,"call_id":"<this>",
//    "peer_call_id":"<target>","source":"transfer_target"}``.
// The ``source`` discriminator lets the worker distinguish these
// post-bridge target-leg presses from ordinary pre-bridge caller DTMF.
// No-op unless the leg was bridged with monitor_dtmf.
func (c *Call) maybeEmitPeerDTMF(peerCallID string, payload []byte) {
	c.mu.Lock()
	monitoring := c.dtmfMonitor
	c.mu.Unlock()
	if !monitoring || c.ws == nil {
		return
	}
	ev, ok := rtp.ParseDTMF(payload)
	if !ok || !ev.End {
		return
	}
	sym := ev.Symbol()
	if sym == 0 {
		return
	}
	// Drop end-of-event retransmissions: same symbol + duration within
	// 250 ms is the same keypress reported again, not a new press.
	now := time.Now().UnixNano()
	c.mu.Lock()
	last := c.lastMonitorDTMF
	if last.sym == sym && last.duration == ev.Duration && now-last.atNanos < int64(250*time.Millisecond) {
		c.mu.Unlock()
		return
	}
	c.lastMonitorDTMF.sym = sym
	c.lastMonitorDTMF.duration = ev.Duration
	c.lastMonitorDTMF.atNanos = now
	c.mu.Unlock()
	durationMS := int(uint32(ev.Duration) / 8)
	msg := fmt.Sprintf(
		`{"type":"dtmf","digit":%q,"duration_ms":%d,"call_id":%q,"peer_call_id":%q,"source":"transfer_target"}`,
		string(sym), durationMS, c.callID, peerCallID,
	)
	if err := c.ws.SendMessage(msg); err != nil {
		log.Warn().Err(err).Str("call_id", c.callID).Msg("call: monitor dtmf ws send failed")
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
	// In relay mode the two SIP legs own the media path. A monitored
	// bridge keeps the worker WS open for control/DTMF only — any bot
	// audio still in flight must not be mixed onto the caller's RTP.
	if c.hasPeer() {
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
	tap := c.tap
	c.tap = nil
	c.mu.Unlock()
	if tap != nil {
		tap.Stop()
	}
	if c.releaseStop != nil {
		c.releaseStop()
	}
	if c.mediaTimeoutStop != nil {
		c.mediaTimeoutStop()
	}
	if c.rtp != nil {
		c.rtp.Close()
	}
	if c.ws != nil {
		c.ws.Stop()
	}
}

// startMediaTimeoutWatchdog spawns a ticker that tears the call down
// when no inbound RTP has been seen for ``timeoutSec`` seconds. Used
// to detect peers (Twilio Elastic SIP Trunk in particular) that stop
// sending media when the caller hangs up but never bother to send a
// BYE. Without this the bridge would happily keep the call leg alive
// forever, leaking the worker Pipecat session and any upstream
// trunk slot.
//
// The hangup parameter is the manager-level teardown — it sends a SIP
// BYE upstream (so the carrier releases its end) AND closes the local
// call. Plain ``c.Close()`` is wrong here: that leaves the SIP dialog
// open from the peer's perspective, which on some carriers leaks
// channel-equivalent state for the dialog-timer's default ~32 minutes.
func (c *Call) startMediaTimeoutWatchdog(timeoutSec int, hangup func()) {
	if timeoutSec <= 0 || hangup == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.mediaTimeoutStop = cancel
	timeoutNanos := int64(timeoutSec) * int64(time.Second)
	// Tick at 1/3 of the timeout — fine-grained enough to catch the
	// silence quickly, coarse enough not to thrash the scheduler.
	tickInterval := time.Duration(timeoutNanos / 3)
	if tickInterval < time.Second {
		tickInterval = time.Second
	}
	go func() {
		ticker := time.NewTicker(tickInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if c.isClosed() {
					return
				}
				silenceNanos := time.Now().UnixNano() - c.lastRTPNanos.Load()
				if silenceNanos < timeoutNanos {
					continue
				}
				log.Warn().
					Str("call_id", c.callID).
					Int("timeout_s", timeoutSec).
					Float64("silence_s", float64(silenceNanos)/float64(time.Second)).
					Bool("ever_received_rtp", c.firstRTPLogged.Load()).
					Msg("rtp: media timeout — tearing down (no BYE from peer; Twilio-style silent hangup)")
				hangup()
				return
			}
		}
	}()
}

func (c *Call) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}
