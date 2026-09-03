// Package sip implements the SIP UAS for the sipbridge.
//
// Phase A scope: accept inbound INVITE from a known peer (our B2BUA
// front), negotiate G.711, run a media bridge through the call manager,
// handle ACK + BYE for clean teardown. No REGISTER, no REFER, no
// authentication — those land in later phases (consult/transfer in
// Phase C, REFER blind in Phase B, registrar never).
package sip

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// InviteHandler is invoked by the SIP server when a new INVITE arrives
// and has been parsed (codec offer + remote endpoint). The handler
// returns the answer SDP body to send in the 200 OK; if it returns an
// error, the server replies with the matching status code (default 500)
// and tears down the transaction.
//
// If the handler wants to control the SIP response code (e.g. "no agent
// for this number" should be SIP 404, not the generic 500), it can
// return a ``*RejectError`` instead of a bare error — the server will
// honour ``RejectError.SIPCode`` and ``RejectError.Reason``.
//
// The call manager registers the handler in call.Manager.RegisterSIP().
type InviteHandler func(ctx context.Context, callID string, offer *CodecOffer, headers IncomingHeaders) (sdpAnswer []byte, err error)

// RejectError is the typed error an InviteHandler returns when it wants
// the SIP server to respond with a specific status code (e.g. 404 Not
// Found rather than 500 Server Error). The Reason is the SIP reason
// phrase appended after the status code on the wire.
//
// Use the helper constructors below where possible — they pick sensible
// reason phrases and ensure the status code is in the SIP response
// range (3xx–6xx).
type RejectError struct {
	SIPCode int
	Reason  string
	// Cause is the underlying error (e.g. the wrapped DialError from
	// the Pipecat WS client). It's preserved via Unwrap so the caller
	// can drill down with errors.As / errors.Is for logging.
	Cause error
}

func (e *RejectError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("sip reject %d %s: %v", e.SIPCode, e.Reason, e.Cause)
	}
	return fmt.Sprintf("sip reject %d %s", e.SIPCode, e.Reason)
}

func (e *RejectError) Unwrap() error { return e.Cause }

// ByeHandler is invoked on inbound BYE. The server has already
// 200-OK'd the BYE on the wire; the handler just gets the chance to
// tear down its own per-call state.
type ByeHandler func(callID string)

// IncomingHeaders carries the bits of the inbound INVITE the call
// manager actually cares about — mostly the X-Aplisay-* headers that
// flow through the B2BUA front from the carrier-side INVITE (see
// section 6 of docs/livekit-agent-architecture.md).
type IncomingHeaders struct {
	From string
	To   string
	// FromDisplayName is the From header's display-name — the caller's
	// freeform name as presented on the wire (`"Alice Smith" <sip:+44…>` →
	// `Alice Smith`) — as sipgo parsed it: surrounding quotes stripped,
	// backslash quoted-pairs left in place. Empty when the From carried no
	// display-name. Forwarded to the worker on the WS handshake as
	// X-Sipbridge-From-Name → metadata.aplisay.callerIdName.
	FromDisplayName string
	// Custom headers we expect from the upstream B2BUA. Anything not
	// listed here that arrives is preserved in Extra so debug tooling
	// can inspect it.
	AplisayTrunk             string
	AplisayPhoneRegistration string
	AplisayCallID            string
	AplisayB2BUAGatewayIP    string
	AplisayB2BUATransport    string
	Extra                    map[string]string
}

// Server is the sipgo wrapper that owns the UAS lifecycle.
type Server struct {
	ua  *sipgo.UserAgent
	srv *sipgo.Server
	ub  *sipgo.DialogUA

	mu      sync.Mutex
	calls   map[string]*activeCall // sip CallID → state for ACK/BYE matching
	invite  InviteHandler
	bye     ByeHandler
	// signalIP is the IP we advertise (Via/Contact); bindIP is the
	// address we actually listen on. They differ on any non-trivial
	// deployment — see Config docs and docker-compose for the rationale.
	signalIP      string
	signalPort    int
	tlsSignalPort int
	bindIP        string

	// authUsername / authPassword are the SIP digest credentials presented
	// when an outbound INVITE is challenged (401/407) — i.e. the credentials
	// the outbound SBC requires. Part of the "outbound trunk" config (mirrors
	// LiveKit's createSipOutboundTrunk authUsername/authPassword). Empty when
	// the SBC doesn't challenge (or for registration-origin legs to a B2BUA
	// gateway, which don't authenticate).
	authUsername string
	authPassword string

	// fromDomain is the host part presented in the From of outbound INVITEs
	// (the From user is the per-call CLI). The upstream SBC gates outbound-
	// trunk routing on this domain, so it must be a handler domain the SBC
	// recognises. Empty → let sipgo synthesise a default From.
	fromDomain string

	// traceEnabled gates the full-message SIP trace logger (see
	// traceSIP) — set from Config.TraceEnabled at NewServer time.
	traceEnabled bool
}

// traceSIP logs a SIP message at INFO with full headers + body when
// tracing is enabled. ``direction`` is a short prefix like ``>``
// (outbound / bridge → peer) or ``<`` (inbound / peer → bridge).
// ``label`` describes the context (e.g. "inbound request", "200 OK for
// INVITE"). The full wire form comes from sipgo's ``msg.String()``.
//
// Used to diagnose dialog-level issues — missing BYE, weird SDP from
// the SBC, retransmits, etc. Heavy but invaluable when something's
// going wrong below the call manager.
type sipMessage interface {
	String() string
	StartLine() string
}

func (s *Server) traceSIP(direction, label string, msg sipMessage) {
	if !s.traceEnabled || msg == nil {
		return
	}
	log.Info().
		Str("dir", direction).
		Str("label", label).
		Str("start_line", msg.StartLine()).
		Msgf("sip trace:\n%s%s", direction+" ", strings.ReplaceAll(msg.String(), "\n", "\n"+direction+" "))
}

// activeCall holds the per-Call-ID dialog reference plus a discriminator
// for whether we're the UAS (inbound) or UAC (outbound) side. Hangup +
// REFER both work off of these dialog handles, but the underlying sipgo
// type differs so we keep both fields and use whichever is populated.
type activeCall struct {
	uas *sipgo.DialogServerSession
	uac *sipgo.DialogClientSession
}

// OutboundResult is what `Originate` returns once the far end has
// answered. The call manager wires RTP with `Answer` and stores
// `CallID` for subsequent transfer/hangup REST calls.
type OutboundResult struct {
	CallID string
	Answer *CodecOffer // SDP answer parsed from the 200 OK body
}

// SIPResponseError is returned by Originate when the outbound INVITE receives a
// non-2xx final response. It carries the status code so callers can branch on
// it — notably to retry a plaintext RTP/AVP offer when a carrier rejects SRTP
// with 488 Not Acceptable Here (Twilio: "SIP trunk does not accept secure").
type SIPResponseError struct {
	Code   int
	Reason string
}

func (e *SIPResponseError) Error() string {
	return fmt.Sprintf("sip: INVITE final %d %s", e.Code, e.Reason)
}

// Config controls how the server binds and presents itself on the wire.
type Config struct {
	// SignalIP is the IP advertised in the Contact / Via headers — the
	// upstream B2BUA will route ACK/BYE back here. With host networking
	// inside our LAN this is usually the same as BindIP.
	SignalIP string
	// SignalPort is the SIP port to listen on (UDP). Default 5060.
	SignalPort int
	// TLSSignalPort is the SIPS port we advertise in the Contact for
	// dialogs established over TLS. Should match the port the TLS
	// listener is bound to (typically 5061). Used to build a
	// ``sips:...:<port>;transport=tls`` Contact per RFC 5630 §5.5
	// when answering an INVITE that arrived over TLS — answering a
	// SIPS dialog with a plaintext sip: Contact forces in-dialog
	// requests (ACK, BYE, re-INVITE) to fail back to UDP, which
	// almost always means they're routed to nowhere when behind NAT.
	TLSSignalPort int
	// BindIP is the address to bind the UDP listener to. Defaults to
	// SignalIP if empty.
	BindIP string
	// UserAgent string sent in the User-Agent / Server header.
	UserAgent string

	// AuthUsername / AuthPassword: SIP digest credentials for outbound
	// INVITEs that the SBC challenges (401/407). Part of the outbound-trunk
	// config — the analogue of LiveKit's createSipOutboundTrunk
	// authUsername/authPassword. Empty disables auth (peer must accept
	// unauthenticated, e.g. an IP-allowlisted SBC or a registration B2BUA).
	AuthUsername string
	AuthPassword string

	// FromDomain: host presented in the From of outbound INVITEs (user is the
	// per-call CLI). Must be a handler domain the upstream SBC recognises for
	// outbound-trunk routing. Empty → sipgo's default From.
	FromDomain string

	// TraceEnabled: when true, every SIP message that crosses the
	// bridge — inbound requests, our outbound responses, our outbound
	// requests, and the responses we receive — is logged at INFO
	// level with full headers + body. Heavy: a typical call produces
	// 10–15 message lines. Use for diagnosing dialog-level issues
	// (where's the BYE, what's in the SDP, etc).
	TraceEnabled bool
}

// NewServer builds and configures the UAS but does not start listening
// (call Listen to begin serving).
func NewServer(cfg Config) (*Server, error) {
	if cfg.SignalPort == 0 {
		cfg.SignalPort = 5060
	}
	if cfg.BindIP == "" {
		cfg.BindIP = cfg.SignalIP
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = "aplisay-sipbridge/0.1"
	}

	// Outbound TLS config used when sipgo dials a new client connection
	// for in-dialog requests (typically BYE) that can't reuse the
	// inbound TLS connection — e.g. when the peer (Twilio Elastic SIP
	// Trunk, classically) closed the inbound side as part of their
	// silent hangup. ``InsecureSkipVerify=true`` is deliberate:
	//
	//   - Carrier certs (Twilio, Bandwidth, Telnyx, …) generally have
	//     DNS-name SANs only (``*.pstn.twilio.com`` etc.). When we
	//     reconnect by IP — which is all sipgo's transport layer
	//     knows from ``InviteRequest.Source()`` — Go's verifier
	//     refuses with "doesn't contain any IP SANs".
	//   - We're not the side authenticating the peer here — the SIP
	//     dialog state machine carries our authentication via the
	//     dialog Call-ID + tags. The TLS layer is just providing
	//     transport confidentiality between us and a peer we already
	//     trust (we accepted their INVITE).
	//
	// If you ever want a stricter policy in production — pinning the
	// carrier cert, or providing a CA bundle so DNS-name validation
	// works — replace this with a tls.Config that has RootCAs set.
	clientTLSConf := &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // see comment above
		MinVersion:         tls.VersionTLS12,
	}
	ua, err := sipgo.NewUA(
		sipgo.WithUserAgent(cfg.UserAgent),
		sipgo.WithUserAgenTLSConfig(clientTLSConf),
	)
	if err != nil {
		return nil, fmt.Errorf("sip: NewUA: %w", err)
	}
	srv, err := sipgo.NewServer(ua)
	if err != nil {
		return nil, fmt.Errorf("sip: NewServer: %w", err)
	}
	// DialogUA is the helper that owns the UAS-side dialog state for
	// ReadInvite/ReadAck/ReadBye. We need a Client handle on it for
	// future BYE-initiated-by-us paths (Phase B); for Phase A inbound
	// we only call ReadInvite and ReadAck/ReadBye.
	client, err := sipgo.NewClient(ua)
	if err != nil {
		return nil, fmt.Errorf("sip: NewClient: %w", err)
	}
	contact := sip.ContactHeader{
		Address: sip.Uri{
			User:      "sipbridge",
			Host:      cfg.SignalIP,
			Port:      cfg.SignalPort,
			UriParams: sip.HeaderParams{},
		},
	}
	dua := &sipgo.DialogUA{
		Client:     client,
		ContactHDR: contact,
		// RewriteContact: in-dialog requests (BYE, re-INVITE, REFER, …)
		// go to the wire-level source of the INVITE rather than the
		// Contact URI's host. Without this, sipgo follows the Contact
		// URI literally — which is fatal for peers behind NAT or in
		// separate Docker networks, where the Contact often advertises
		// an unroutable RFC1918 / Docker-bridge IP (e.g. 172.18.x.x).
		//
		// This is RFC 5923 "Connection Reuse" for TLS dialogs and the
		// equivalent NAT-traversal answer for UDP. It mirrors what
		// every B2BUA / SBC does by default; sipgo just doesn't turn
		// it on without us asking. Comment in dialog_ua.go:20 sums it
		// up: "Should be used when behind NAT."
		RewriteContact: true,
	}

	s := &Server{
		ua:            ua,
		srv:           srv,
		ub:            dua,
		calls:         make(map[string]*activeCall),
		signalIP:      cfg.SignalIP,
		signalPort:    cfg.SignalPort,
		tlsSignalPort: cfg.TLSSignalPort,
		bindIP:        cfg.BindIP,
		authUsername:  cfg.AuthUsername,
		authPassword:  cfg.AuthPassword,
		fromDomain:    cfg.FromDomain,
		traceEnabled:  cfg.TraceEnabled,
	}
	s.registerHandlers()
	// Surface outbound-trunk config at startup so a 401/407 failure is easy to
	// diagnose: sipgo only answers an auth challenge when a password is set, so
	// "auth_password_set=false" here explains an outbound INVITE that dies on
	// 407. The password value itself is never logged.
	log.Info().
		Str("from_domain", cfg.FromDomain).
		Str("auth_username", cfg.AuthUsername).
		Bool("auth_password_set", cfg.AuthPassword != "").
		Msg("sip: outbound trunk config")
	return s, nil
}

// SetInviteHandler registers the per-call setup handler.
func (s *Server) SetInviteHandler(h InviteHandler) { s.invite = h }

// SetByeHandler registers the per-call teardown handler.
func (s *Server) SetByeHandler(h ByeHandler) { s.bye = h }

// Listen binds the UDP socket and starts the SIP transaction loop.
// Returns when the context is cancelled or the listener errors fatally.
//
// We bind to bindIP (which defaults to signalIP if unset). They differ
// in any Docker / NAT deployment: bind on 0.0.0.0 to receive packets on
// every interface, but keep signalIP as the routable address peers see
// in Via / Contact / SDP.
func (s *Server) Listen(ctx context.Context) error {
	addr := net.JoinHostPort(s.bindIP, fmt.Sprintf("%d", s.signalPort))
	log.Info().
		Str("addr", addr).
		Str("advertised", fmt.Sprintf("%s:%d", s.signalIP, s.signalPort)).
		Msg("sip: listening (UDP)")
	return s.srv.ListenAndServe(ctx, "udp", addr)
}

// ListenTLS binds an additional TCP/TLS listener (SIPS, port 5061 by
// convention). Carriers / B2BUAs targeting SIPS use this; the UDP
// listener stays up in parallel for non-TLS peers, unless the operator
// disabled it via ``SIPBRIDGE_SIP_UDP_DISABLED``.
//
// The cert is built and passed in by the caller (see ``LoadOrGenerateCert``
// in cert.go). Cert rotation requires a restart for v1.
func (s *Server) ListenTLS(ctx context.Context, port int, cert tls.Certificate) error {
	cfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}
	// Same bind-vs-advertise split as the UDP listener.
	addr := net.JoinHostPort(s.bindIP, fmt.Sprintf("%d", port))
	log.Info().
		Str("addr", addr).
		Str("advertised", fmt.Sprintf("%s:%d", s.signalIP, port)).
		Msg("sip: listening (TLS)")
	return s.srv.ListenAndServeTLS(ctx, "tcp", addr, cfg)
}

// Close stops the server cleanly. Safe to call after a failed Listen.
func (s *Server) Close() error {
	if s.srv != nil {
		return s.srv.Close()
	}
	return nil
}

func (s *Server) registerHandlers() {
	s.srv.OnInvite(s.onInvite)
	s.srv.OnAck(s.onAck)
	s.srv.OnBye(s.onBye)
	// CANCEL / OPTIONS get a default 200 OK / 487 from sipgo's
	// transaction layer; we don't need to override unless we add load
	// shedding or "OPTIONS keepalive" tracking.
	//
	// OnNoRoute fires for any inbound request that doesn't match the
	// registered handlers (OPTIONS, INFO, REFER, MESSAGE, etc). We
	// don't have business logic for these but we want them in the
	// trace when tracing is on, so we can see e.g. carrier OPTIONS
	// keepalives or unexpected REFERs. Respond 501 Not Implemented so
	// the peer doesn't retransmit.
	s.srv.OnNoRoute(func(req *sip.Request, tx sip.ServerTransaction) {
		s.traceSIP("<", "no-route ("+string(req.Method)+")", req)
		s.respond(req, tx, 501, "Not Implemented", nil)
	})
}

func (s *Server) onInvite(req *sip.Request, tx sip.ServerTransaction) {
	s.traceSIP("<", "INVITE", req)
	callID := req.CallID().Value()
	// Log the wire-level source of the INVITE up front. SIP responses go
	// back to this address (with rport / received semantics), so if it
	// shows as loopback (``[::1]:5060`` or ``127.0.0.1``) instead of the
	// peer's real IP, your responses will loop back into the bridge
	// rather than reach the peer. The most common cause is Docker
	// Desktop's "host networking" not preserving source addresses on
	// inbound UDP — enable real host networking (4.29+) or run sipbridge
	// directly on the host.
	log.Info().
		Str("call_id", callID).
		Str("source", req.Source()).
		Str("destination", req.Destination()).
		Msg("sip: INVITE received")
	if s.invite == nil {
		s.respond(req, tx, 500, "No handler", nil)
		return
	}

	body := req.Body()
	offer, err := ParseOffer(body)
	if err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: bad SDP in INVITE")
		s.respond(req, tx, 488, "Not Acceptable Here", nil)
		return
	}

	headers := extractHeaders(req)

	// Provisional 100 Trying — the answer build below can take a moment
	// (allocating an RTP port + opening the worker WS), so give the
	// upstream B2BUA confidence the request is being processed.
	tryingResp := sip.NewResponseFromRequest(req, 100, "Trying", nil)
	s.traceSIP(">", "100 Trying for INVITE", tryingResp)
	_ = tx.Respond(tryingResp)

	answer, err := s.invite(context.Background(), callID, offer, headers)
	if err != nil {
		// Default rejection: 500. Handlers signal a different SIP status
		// (e.g. 404 No Agent, 503 Worker Unavailable) by returning a
		// *RejectError.
		code, reason := 500, "Server Error"
		var rej *RejectError
		if errors.As(err, &rej) {
			code, reason = rej.SIPCode, rej.Reason
		}
		log.Warn().
			Err(err).
			Str("call_id", callID).
			Int("sip_code", code).
			Str("sip_reason", reason).
			Msg("sip: invite handler rejected")
		s.respond(req, tx, code, reason, nil)
		return
	}

	// Wire the dialog: ReadInvite is the helper that builds the
	// DialogServerSession + computes the to-tag etc. We hold onto the
	// session for ACK / BYE matching.
	dlg, err := s.ub.ReadInvite(req, tx)
	if err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: ReadInvite failed")
		s.respond(req, tx, 500, "Server Error", nil)
		return
	}
	s.mu.Lock()
	s.calls[callID] = &activeCall{uas: dlg}
	s.mu.Unlock()

	// 200 OK with our SDP answer. Critical detail: we build the
	// response from ``dlg.Dialog.InviteRequest`` rather than the raw
	// ``req`` we got from the handler. ReadInvite (sipgo's dialog_ua.go
	// line ~40) clones the request and stamps a UUID-derived
	// ``;tag=`` onto the To header, then stores that augmented copy
	// AND derives the dialog ID from it. If we build the 200 OK
	// from the raw request (no To-tag), WriteResponse computes a
	// different dialog ID from the response and refuses with
	// "ID do not match. Invite request has changed headers?" —
	// silently breaking dialog establishment.
	//
	// Content-Type must be application/sdp (sipgo's
	// NewResponseFromRequest copies request headers but doesn't set
	// Content-Type). Contact is added by WriteResponse from the
	// DialogUA's ContactHDR if we don't supply one ourselves.
	resp := sip.NewResponseFromRequest(dlg.Dialog.InviteRequest, 200, "OK", answer)
	resp.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	// Transport-appropriate Contact. The UA's stored ContactHDR is a
	// plain ``sip:`` URI on the UDP signal port — wrong for TLS
	// dialogs. Per RFC 5630 §5.5, a UAS answering an INVITE over
	// TLS MUST emit a ``sips:`` Contact reachable over TLS;
	// otherwise the peer routes subsequent in-dialog requests
	// (notably the ACK to our 200 OK) over UDP to whatever URI we
	// gave them — which behind NAT goes nowhere. We synthesise the
	// right Contact per-call from the dialog's transport.
	resp.AppendHeader(s.contactForDialog(dlg))
	s.traceSIP(">", "200 OK for INVITE", resp)
	// Send the 200 OK via the dialog's WriteResponse rather than
	// tx.Respond. Critical difference: WriteResponse stamps
	// ``s.Dialog.InviteResponse = res`` (so later in-dialog requests
	// like BYE can synthesise their ``From`` header from the dialog
	// state via buildReq), drives the 2xx retransmit timer until ACK
	// arrives, and transitions the dialog state machine through
	// Established → Confirmed. tx.Respond does none of that —
	// using it left the dialog session blind to its own 200 OK, and
	// every subsequent BYE was missing its From header, which the
	// peer (Twilio) silently drops as a parse violation.
	//
	// WriteResponse blocks until the ACK arrives (or 64*T1 ≈ 32s
	// timeout). sipgo continues to dispatch other inbound messages
	// (including the ACK itself, which our OnAck handler then forwards
	// to dlg.ReadAck — that's what unblocks us).
	if err := dlg.WriteResponse(resp); err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: WriteResponse (200 OK) failed")
		s.cleanupCall(callID)
		return
	}
	log.Info().
		Str("call_id", callID).
		Str("from", headers.From).
		Str("to", headers.To).
		Msg("sip: INVITE answered")
}

// contactForDialog builds a Contact header appropriate for the dialog
// transport. TLS dialogs get a ``sips:`` URI on the TLS port with
// ``;transport=tls`` (RFC 5630 §5.5); everything else gets a ``sip:``
// URI on the UDP port. The host is our advertised SignalIP — same
// address peers used to reach us for the INVITE.
//
// Why this matters: the peer's UAC uses our Contact as the target
// for the ACK to our 2xx AND as the remote-target in the route set
// for all subsequent in-dialog requests. A ``sip:`` Contact on UDP
// 5060 forces TLS-arrived peers to switch to UDP for the ACK, and
// when our advertised host isn't reachable over UDP from the peer
// (typical behind NAT / Docker) the ACK silently vanishes — the
// dialog never confirms, sipgo's WriteResponse retransmits the 200
// OK for 32s, then gives up.
func (s *Server) contactForDialog(dlg *sipgo.DialogServerSession) *sip.ContactHeader {
	transport := ""
	if dlg.Dialog.InviteRequest != nil {
		transport = dlg.Dialog.InviteRequest.Transport()
	}
	return &sip.ContactHeader{Address: s.contactURI(transport)}
}

// contactURI builds the Contact address for a dialog running over the
// named transport. Shared by the UAS path (contactForDialog, answering
// an inbound INVITE) and the UAC path (Originate, dialling out) so both
// directions advertise a reachable target — see contactForDialog for
// why a transport-mismatched Contact breaks in-dialog routing.
func (s *Server) contactURI(transport string) sip.Uri {
	uri := sip.Uri{
		User: "sipbridge",
		Host: s.signalIP,
		Port: s.signalPort,
	}
	switch strings.ToLower(transport) {
	case "tls", "wss":
		uri.Scheme = "sips"
		if s.tlsSignalPort > 0 {
			uri.Port = s.tlsSignalPort
		}
		uri.UriParams = sip.NewParams()
		uri.UriParams.Add("transport", "tls")
	}
	return uri
}

// isTLSURI reports whether a request URI names a TLS destination —
// either a ``sips:`` scheme or an explicit ``;transport=tls``.
func isTLSURI(u sip.Uri) bool {
	if strings.EqualFold(u.Scheme, "sips") {
		return true
	}
	return strings.EqualFold(u.UriParams.GetOr("transport", ""), "tls")
}

func (s *Server) onAck(req *sip.Request, tx sip.ServerTransaction) {
	s.traceSIP("<", "ACK", req)
	// ACK transitions the dialog to Confirmed. sipgo's
	// DialogServerSession.ReadAck does this; we just need to forward.
	callID := req.CallID().Value()
	s.mu.Lock()
	c := s.calls[callID]
	s.mu.Unlock()
	if c == nil {
		log.Debug().Str("call_id", callID).Msg("sip: ACK for unknown dialog")
		return
	}
	if c.uas == nil {
		// ACK arrived on a dialog we don't own as UAS. Outbound (UAC)
		// dialogs don't ReadAck — sipgo's Invite/WaitAnswer handles
		// the ACK round-trip internally.
		return
	}
	if err := c.uas.ReadAck(req, tx); err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: ReadAck failed")
	}
}

func (s *Server) onBye(req *sip.Request, tx sip.ServerTransaction) {
	s.traceSIP("<", "BYE", req)
	callID := req.CallID().Value()
	// Log every BYE so the path from SIP wire → call manager teardown
	// → worker WS close is visible. Without this it's impossible to
	// tell from logs whether the peer's BYE actually arrived or got
	// dropped somewhere (e.g. closed TCP connection on TLS transports).
	log.Info().
		Str("call_id", callID).
		Str("source", req.Source()).
		Msg("sip: BYE received")
	s.mu.Lock()
	c := s.calls[callID]
	s.mu.Unlock()
	if c == nil {
		// Unknown dialog — respond 200 anyway so the far end stops
		// retransmitting (some carriers re-send BYE after a missed
		// ACK).
		log.Warn().
			Str("call_id", callID).
			Msg("sip: BYE for unknown dialog — call manager won't tear down (was the INVITE answered on this bridge?)")
		s.respond(req, tx, 200, "OK", nil)
		return
	}
	// ReadBye sends the 200 OK itself; we don't double-respond. The
	// UAS and UAC variants take the same args so we just route to the
	// populated dialog.
	if c.uas != nil {
		if err := c.uas.ReadBye(req, tx); err != nil {
			log.Warn().Err(err).Str("call_id", callID).Msg("sip: ReadBye (UAS) failed")
		}
	} else if c.uac != nil {
		if err := c.uac.ReadBye(req, tx); err != nil {
			log.Warn().Err(err).Str("call_id", callID).Msg("sip: ReadBye (UAC) failed")
		}
	}
	s.cleanupCall(callID)
	if s.bye != nil {
		s.bye(callID)
	}
}

func (s *Server) cleanupCall(callID string) {
	s.mu.Lock()
	delete(s.calls, callID)
	s.mu.Unlock()
}

// respond is the inline error-reply helper. Used when we don't want to
// allocate a full dialog (e.g. an INVITE we're rejecting before
// ReadInvite). Body may be nil.
func (s *Server) respond(req *sip.Request, tx sip.ServerTransaction, code int, reason string, body []byte) {
	resp := sip.NewResponseFromRequest(req, code, reason, body)
	s.traceSIP(">", fmt.Sprintf("%d %s for %s", code, reason, req.Method), resp)
	if err := tx.Respond(resp); err != nil {
		log.Warn().Err(err).Int("code", code).Msg("sip: respond failed")
	}
}

func extractHeaders(req *sip.Request) IncomingHeaders {
	h := IncomingHeaders{Extra: map[string]string{}}
	if f := req.From(); f != nil {
		h.From = f.Address.String()
		h.FromDisplayName = f.DisplayName
	}
	if t := req.To(); t != nil {
		h.To = t.Address.String()
	}
	for _, hdr := range req.Headers() {
		name := strings.ToLower(hdr.Name())
		if !strings.HasPrefix(name, "x-") {
			continue
		}
		val := hdr.Value()
		switch name {
		case "x-aplisay-trunk":
			h.AplisayTrunk = val
		case "x-aplisay-phoneregistration":
			h.AplisayPhoneRegistration = val
		case "x-aplisay-call-id":
			h.AplisayCallID = val
		case "x-lk-realip":
			h.AplisayB2BUAGatewayIP = val
		case "x-lk-transport":
			h.AplisayB2BUATransport = val
		default:
			h.Extra[name] = val
		}
	}
	return h
}

// NewCallID returns a fresh dialog-style Call-ID for outbound requests.
// Format: random uuid @ signal-ip, matching what most B2BUAs do.
func (s *Server) NewCallID() string {
	return fmt.Sprintf("%s@%s", uuid.New().String(), s.signalIP)
}

// Originate sends an outbound INVITE, waits for the 200 OK, ACKs, and
// returns the parsed SDP answer. The caller is the call manager,
// which has already allocated the local RTP socket and built ``sdpOffer``
// to advertise it.
//
// On any failure (4xx/5xx/6xx final, transport, timeout) the dialog is
// terminated cleanly and an error is returned; the caller is
// responsible for tearing down the RTP socket on the error path.
func (s *Server) Originate(
	ctx context.Context,
	target string,
	fromUser string,
	sdpOffer []byte,
	customHeaders map[string]string,
) (*OutboundResult, *sipgo.DialogClientSession, error) {
	targetURI := sip.Uri{}
	if err := sip.ParseUri(target, &targetURI); err != nil {
		return nil, nil, fmt.Errorf("invalid target URI %q: %w", target, err)
	}

	// Headers ride alongside the INVITE on the wire. SIP routers along
	// the path are required to preserve unknown headers, so the
	// upstream B2BUA / carrier sees the X-Aplisay-* / X-Lk-* contract.
	extra := []sip.Header{
		sip.NewHeader("Content-Type", "application/sdp"),
	}
	// Present a real From identity. Without this, sipgo synthesises
	// ``From: "<ua-name>" <sip:<ua-name>@localhost>`` (it only fills From when
	// the request has none — so providing our own wins, no duplicate). The
	// upstream SBC keys its outbound-trunk routing off the From: it gates on
	// the From *domain* (must be a recognised handler domain) and rewrites the
	// From *user* (the calling number) per the trunk's from_format. We set the
	// user to the resolved CLI and the host to the configured handler domain;
	// when either is unset we leave sipgo's default (e.g. for peers that
	// authenticate purely by source IP).
	if s.fromDomain != "" && fromUser != "" {
		from := &sip.FromHeader{
			Address: sip.Uri{Scheme: "sip", User: fromUser, Host: s.fromDomain},
			Params:  sip.NewParams(),
		}
		from.Params.Add("tag", sip.GenerateTagN(16))
		extra = append(extra, from)
	}
	for k, v := range customHeaders {
		extra = append(extra, sip.NewHeader(k, v))
	}

	// Advertise a Contact that matches the transport we're dialling out
	// over. The DialogUA carries a single static ContactHDR, built in
	// NewServer for the plaintext UDP case; for a TLS target we Invite on
	// a shallow copy carrying the ``sips:``/TLS-port/``;transport=tls``
	// form instead. (Copy rather than mutate: Originate runs concurrently
	// for every outbound call on this Server.)
	//
	// This is the UAC twin of the contactForDialog bug, and it fails the
	// same silent way — the peer takes our Contact as the remote target
	// for the whole dialog, so a ``sip:...:5060`` Contact on a TLS dialog
	// sends their BYE to UDP 5060. Kamailio logs "protocol/port mismatch
	// (forced tls:...:5061, to udp:...:5060)", the BYE times out at 408,
	// and the leg lingers until the RTP watchdog reaps it seconds later.
	ua := s.ub
	if isTLSURI(targetURI) {
		tlsUA := *s.ub
		tlsUA.ContactHDR = sip.ContactHeader{Address: s.contactURI("tls")}
		ua = &tlsUA
	}

	dlg, err := ua.Invite(ctx, targetURI, sdpOffer, extra...)
	if err != nil {
		return nil, nil, fmt.Errorf("sip: Invite: %w", err)
	}
	if dlg.InviteRequest != nil {
		s.traceSIP(">", "INVITE (outbound)", dlg.InviteRequest)
	}

	// WaitAnswer blocks for the final response. Provisional responses
	// (100 Trying / 180 Ringing) are consumed internally. When the SBC
	// challenges the INVITE (401/407), sipgo re-sends with a digest
	// Authorization built from these credentials — the outbound-trunk auth
	// (mirrors LiveKit's createSipOutboundTrunk authUsername/authPassword).
	// Empty creds → no auth attempted (peer must accept unauthenticated).
	var lastResp *sip.Response
	if err := dlg.WaitAnswer(ctx, sipgo.AnswerOptions{
		Username: s.authUsername,
		Password: s.authPassword,
		// Trace EVERY response (provisional, auth challenge, and final) as it
		// arrives. Without this, a non-2xx final (e.g. 404/403) makes WaitAnswer
		// return an error and we'd bail before logging the response — so the
		// SIP trace would show only the outbound INVITE and none of the SBC's
		// answers, which is exactly the blind spot we hit debugging this. Also
		// capture the last response so we can surface its status code.
		OnResponse: func(res *sip.Response) error {
			s.traceSIP("<", fmt.Sprintf("%d %s for outbound INVITE", res.StatusCode, res.Reason), res)
			lastResp = res
			return nil
		},
	}); err != nil {
		_ = dlg.Close()
		// Surface the final status code (e.g. 488) so the caller can decide to
		// retry — sipgo reports non-2xx finals as a WaitAnswer error.
		if lastResp != nil {
			return nil, nil, &SIPResponseError{Code: int(lastResp.StatusCode), Reason: lastResp.Reason}
		}
		return nil, nil, fmt.Errorf("sip: WaitAnswer: %w", err)
	}
	resp := dlg.InviteResponse
	if resp == nil || !resp.IsSuccess() {
		_ = dlg.Close()
		code := 0
		reason := ""
		if resp != nil {
			code = int(resp.StatusCode)
			reason = resp.Reason
		}
		return nil, nil, &SIPResponseError{Code: code, Reason: reason}
	}

	// Carrier sent a 2xx with their SDP answer — parse to extract the
	// codec they chose + the remote RTP endpoint.
	answer, err := ParseOffer(resp.Body())
	if err != nil {
		_ = dlg.Bye(ctx)
		_ = dlg.Close()
		return nil, nil, fmt.Errorf("sip: parse SDP answer: %w", err)
	}

	if err := dlg.Ack(ctx); err != nil {
		_ = dlg.Close()
		return nil, nil, fmt.Errorf("sip: ACK: %w", err)
	}

	callID := resp.CallID().Value()
	s.mu.Lock()
	s.calls[callID] = &activeCall{uac: dlg}
	s.mu.Unlock()

	log.Info().Str("call_id", callID).Str("target", target).Msg("sip: outbound INVITE answered")
	return &OutboundResult{CallID: callID, Answer: answer}, dlg, nil
}

// Refer sends an in-dialog REFER on an existing call, requesting the
// far end transfer their leg to ``target``. RFC 3515 blind transfer:
// we expect a 202 Accepted back; the carrier then drives the new INVITE
// and signals progress via NOTIFY events (which we currently consume
// silently — handler will surface them in Phase C when we need the
// state machine).
//
// Sender side: works on both UAS and UAC dialogs (in-dialog requests
// use the same primitive on either flank). For inbound (UAS) we are
// telling the original caller to call ``target``; for outbound (UAC)
// we are telling the callee to call ``target``.
func (s *Server) Refer(ctx context.Context, callID string, target string) error {
	s.mu.Lock()
	c, ok := s.calls[callID]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sip: REFER: unknown call_id %q", callID)
	}

	// Refer-To: SIP URI of the destination. We accept either a bare
	// URI ("sip:+44...@host") or an unprefixed number ("+44...") and
	// upgrade to a URI in the latter case targeting the upstream
	// B2BUA / outbound proxy.
	referTo := target
	if !strings.HasPrefix(strings.ToLower(target), "sip:") &&
		!strings.HasPrefix(strings.ToLower(target), "sips:") {
		referTo = fmt.Sprintf("sip:%s@%s", target, s.signalIP)
	}

	referHdrs := []sip.Header{
		sip.NewHeader("Refer-To", referTo),
		sip.NewHeader("Referred-By", fmt.Sprintf("<sip:sipbridge@%s>", s.signalIP)),
	}

	if c.uas != nil {
		return s.sendReferOnUAS(ctx, c.uas, referHdrs)
	}
	if c.uac != nil {
		return s.sendReferOnUAC(ctx, c.uac, referHdrs)
	}
	return errors.New("sip: REFER: dialog has no UAS or UAC session")
}

// ReferReplaces sends an attended-transfer REFER on ``parentCallID`` (the
// original caller A↔bridge leg) whose Refer-To embeds a
// ``?Replaces=<consult-dialog>`` pointing at the consult target C. This is
// the SIP-REFER finalisation of a consultative transfer (RFC 3891): A
// re-INVITEs C with Replaces, C swaps the bridge↔C dialog for the A↔C one,
// and the bridge drops both legs from the media path.
//
// The Refer-To target URI and the Replaces dialog identifier (Call-ID +
// to-tag + from-tag) are both derived from the consult leg's dialog
// (``consultCallID``), so the worker only needs to pass the two call ids.
func (s *Server) ReferReplaces(ctx context.Context, parentCallID, consultCallID string) error {
	s.mu.Lock()
	parent, okP := s.calls[parentCallID]
	consult, okC := s.calls[consultCallID]
	s.mu.Unlock()
	if !okP {
		return fmt.Errorf("sip: REFER+Replaces: unknown parent call_id %q", parentCallID)
	}
	if !okC {
		return fmt.Errorf("sip: REFER+Replaces: unknown consult call_id %q", consultCallID)
	}

	target, replaces, err := consultDialogReplaces(consult)
	if err != nil {
		return fmt.Errorf("sip: REFER+Replaces: %w", err)
	}

	// Refer-To MUST be angle-bracket enclosed when it carries an embedded
	// header (the ?Replaces=), per RFC 3515 §2.1 / RFC 3261. The Replaces
	// value is percent-escaped so its ';' and '=' don't terminate the URI.
	referTo := fmt.Sprintf("<%s?Replaces=%s>", target, url.QueryEscape(replaces))
	referHdrs := []sip.Header{
		sip.NewHeader("Refer-To", referTo),
		sip.NewHeader("Referred-By", fmt.Sprintf("<sip:sipbridge@%s>", s.signalIP)),
	}

	log.Info().
		Str("parent_call_id", parentCallID).
		Str("consult_call_id", consultCallID).
		Str("refer_to", referTo).
		Msg("sip: attended REFER + Replaces")

	if parent.uas != nil {
		return s.sendReferOnUAS(ctx, parent.uas, referHdrs)
	}
	if parent.uac != nil {
		return s.sendReferOnUAC(ctx, parent.uac, referHdrs)
	}
	return errors.New("sip: REFER+Replaces: parent dialog has no UAS or UAC session")
}

// consultDialogReplaces derives the Refer-To target URI and the Replaces
// header value for an attended transfer from the consult leg's dialog.
//
// The consult leg is always an outbound (UAC) dialog the bridge originated
// to C, so:
//
//   - target  = the dialled destination AOR (consult INVITE's To URI),
//     which routes via the same upstream path the original caller uses.
//   - replaces = "<call-id>;to-tag=<C's tag>;from-tag=<bridge's tag>".
//     From C's perspective (the UAS of the consult dialog) its local tag is
//     the To-tag of the 200 OK and the remote tag is the From-tag of the
//     INVITE — which is exactly what C needs to match the Replaces.
func consultDialogReplaces(c *activeCall) (target string, replaces string, err error) {
	if c.uac == nil {
		return "", "", errors.New("consult dialog is not an outbound (UAC) dialog")
	}
	inv := c.uac.InviteRequest
	resp := c.uac.InviteResponse
	if inv == nil || resp == nil {
		return "", "", errors.New("consult dialog missing INVITE/response")
	}

	callID := inv.CallID().Value()

	var fromTag, toTag string
	if f := inv.From(); f != nil {
		fromTag = f.Params.GetOr("tag", "")
	}
	if t := resp.To(); t != nil {
		toTag = t.Params.GetOr("tag", "")
	}
	if callID == "" || fromTag == "" || toTag == "" {
		return "", "", fmt.Errorf(
			"consult dialog missing Replaces identifiers (call-id=%q from-tag=%q to-tag=%q)",
			callID, fromTag, toTag,
		)
	}

	if t := inv.To(); t != nil {
		target = t.Address.String()
	}
	if target == "" {
		return "", "", errors.New("consult dialog missing destination URI")
	}

	replaces = fmt.Sprintf("%s;to-tag=%s;from-tag=%s", callID, toTag, fromTag)
	return target, replaces, nil
}

func (s *Server) sendReferOnUAS(
	ctx context.Context, dlg *sipgo.DialogServerSession, headers []sip.Header,
) error {
	// Build an in-dialog REFER. ``Dialog.InviteRequest`` provides the
	// route-set / remote URI / cseq base that sipgo uses to assemble
	// the wire request; we just need to set the method + headers + an
	// empty body.
	remote := dlg.InviteRequest.Contact().Address
	req := sip.NewRequest(sip.REFER, remote)
	for _, h := range headers {
		req.AppendHeader(h)
	}
	tx, err := dlg.TransactionRequest(ctx, req)
	if err != nil {
		return fmt.Errorf("sip: REFER (UAS): %w", err)
	}
	defer tx.Terminate()
	return awaitReferAccept(ctx, tx)
}

func (s *Server) sendReferOnUAC(
	ctx context.Context, dlg *sipgo.DialogClientSession, headers []sip.Header,
) error {
	remote := dlg.InviteResponse.Contact().Address
	req := sip.NewRequest(sip.REFER, remote)
	for _, h := range headers {
		req.AppendHeader(h)
	}
	tx, err := dlg.TransactionRequest(ctx, req)
	if err != nil {
		return fmt.Errorf("sip: REFER (UAC): %w", err)
	}
	defer tx.Terminate()
	return awaitReferAccept(ctx, tx)
}

// awaitReferAccept waits for the 202 Accepted that confirms the far
// end is going to process the REFER. NOTIFY progress events come on a
// separate transaction handled by the server's NOTIFY handler
// (Phase C) — for blind transfer in Phase B we don't need them.
func awaitReferAccept(ctx context.Context, tx sip.ClientTransaction) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tx.Done():
			return tx.Err()
		case r := <-tx.Responses():
			if r == nil {
				return errors.New("sip: REFER: nil response")
			}
			if r.IsProvisional() {
				continue
			}
			if !r.IsSuccess() {
				return fmt.Errorf("sip: REFER rejected: %d %s", r.StatusCode, r.Reason)
			}
			return nil
		}
	}
}

// Hangup sends a BYE on an existing dialog. Used both for outbound
// teardown (after caller-initiated hangup REST call) and as the
// cleanup step after REFER completes.
func (s *Server) Hangup(ctx context.Context, callID string) error {
	s.mu.Lock()
	c, ok := s.calls[callID]
	if ok {
		delete(s.calls, callID)
	}
	s.mu.Unlock()
	if !ok {
		log.Warn().Str("call_id", callID).Msg("sip: hangup: no active dialog (already cleaned up or never created)")
		return fmt.Errorf("sip: hangup: unknown call_id %q", callID)
	}
	// Construct + trace + send BYE on whichever dialog half is
	// populated. We replicate sipgo's DialogXxx.Bye() inline rather
	// than delegating, so we can stamp the BYE into the SIP trace
	// log just before sending AND capture the response — sipgo's
	// WriteBye swallows the response object, so without this inline
	// version we couldn't see what (if anything) the peer replied.
	switch {
	case c.uas != nil:
		bye, err := s.buildByeForUAS(c.uas)
		if err != nil {
			log.Warn().Err(err).Str("call_id", callID).Msg("sip: hangup: build BYE (UAS) failed")
			return err
		}
		return s.sendByeAndTraceResponse(ctx, callID, "UAS", bye, c.uas.TransactionRequest)
	case c.uac != nil:
		bye, err := s.buildByeForUAC(c.uac)
		if err != nil {
			log.Warn().Err(err).Str("call_id", callID).Msg("sip: hangup: build BYE (UAC) failed")
			return err
		}
		return s.sendByeAndTraceResponse(ctx, callID, "UAC", bye, c.uac.TransactionRequest)
	}
	log.Warn().Str("call_id", callID).Msg("sip: hangup: dialog has neither UAS nor UAC handle — nothing to BYE")
	return nil
}

// sendByeAndTraceResponse runs the BYE through the dialog's transaction
// layer (replicating sipgo's ``WriteBye`` minus its dialog-state guard,
// which we can't trust — it returns nil silently if the dialog has
// somehow already been marked Ended, hiding routing failures), traces
// both the outgoing BYE and any final response we get back, and
// returns the appropriate error.
//
// txReq is the dialog session's TransactionRequest method (either
// DialogServerSession's or DialogClientSession's), passed as a value
// so this helper works for both UAS and UAC sides.
func (s *Server) sendByeAndTraceResponse(
	ctx context.Context,
	callID string,
	side string,
	bye *sip.Request,
	txReq func(context.Context, *sip.Request) (sip.ClientTransaction, error),
) error {
	// Pre-buildReq trace: the bare BYE we constructed, before sipgo's
	// dialog layer stamps From/To/Call-ID/CSeq/Route/Via etc. Useful
	// only to see the Request-URI and confirm the build started.
	s.traceSIP(">", "BYE (outbound, "+side+"-side, pre-buildReq)", bye)
	tx, err := txReq(ctx, bye)
	if err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: BYE TransactionRequest failed")
		return err
	}
	defer tx.Terminate()
	// Post-buildReq the request has been mutated in-place with all
	// the dialog-state headers (From, To, Call-ID, CSeq, Via, Route)
	// AND (if RewriteContact applied) a corrected Destination. Log
	// the FINAL wire form — this is what actually went out. If the
	// peer doesn't respond, this is where to look for malformed
	// headers, wrong Route order, missing tags, etc.
	s.traceSIP(">", "BYE (outbound, "+side+"-side, post-buildReq, on the wire)", bye)
	log.Info().
		Str("call_id", callID).
		Str("dest", bye.Destination()).
		Str("transport", bye.Transport()).
		Msg("sip: BYE handed to transaction layer")
	select {
	case res, ok := <-tx.Responses():
		if !ok {
			log.Warn().
				Str("call_id", callID).
				Msg("sip: BYE response channel closed without final — peer never responded (transaction timeout?)")
			return errors.New("sip: BYE got no final response")
		}
		s.traceSIP("<", fmt.Sprintf("%d %s for BYE", res.StatusCode, res.Reason), res)
		if res.StatusCode != 200 {
			return fmt.Errorf("sip: BYE got non-2xx response: %d %s", res.StatusCode, res.Reason)
		}
		log.Info().
			Str("call_id", callID).
			Msg("sip: BYE acknowledged with 200 OK")
		return nil
	case <-ctx.Done():
		log.Warn().
			Err(ctx.Err()).
			Str("call_id", callID).
			Msg("sip: BYE context cancelled before response arrived")
		return ctx.Err()
	}
}

// buildByeForUAS mirrors sipgo's ``DialogServerSession.Bye()`` —
// constructs a BYE request targeted at the Contact the peer published
// in the original INVITE, with the dialog's transport. WriteBye
// populates the From/To/Call-ID/CSeq from the dialog state when it
// runs the request through the transaction layer.
//
// The actual destination override (so the BYE goes back on the same
// connection the INVITE arrived on, rather than dialling out to
// whatever the Contact URI says) is enabled via the ``RewriteContact``
// flag on the parent ``DialogUA`` — see ``NewServer``. sipgo's
// ``buildReq`` honours that flag and calls ``SetDestination`` for us
// inside ``WriteBye``. Doing it ourselves here would be overwritten
// at the same point.
func (s *Server) buildByeForUAS(dlg *sipgo.DialogServerSession) (*sip.Request, error) {
	if dlg.Dialog.InviteRequest == nil {
		return nil, errors.New("dialog has no InviteRequest")
	}
	cont := dlg.Dialog.InviteRequest.Contact()
	if cont == nil {
		return nil, errors.New("dialog InviteRequest has no Contact header")
	}
	bye := sip.NewRequest(sip.BYE, cont.Address)
	bye.SetTransport(dlg.Dialog.InviteRequest.Transport())
	return bye, nil
}

// buildByeForUAC mirrors sipgo's ``DialogClientSession.Bye()`` — same
// shape but the target Contact lives on the InviteResponse rather than
// the InviteRequest. Destination override is handled by sipgo's
// ``RewriteContact`` flag (see ``buildByeForUAS`` rationale).
func (s *Server) buildByeForUAC(dlg *sipgo.DialogClientSession) (*sip.Request, error) {
	if dlg.Dialog.InviteResponse == nil {
		return nil, errors.New("dialog has no InviteResponse")
	}
	cont := dlg.Dialog.InviteResponse.Contact()
	if cont == nil {
		return nil, errors.New("dialog InviteResponse has no Contact header")
	}
	bye := sip.NewRequest(sip.BYE, cont.Address)
	if dlg.Dialog.InviteRequest != nil {
		bye.SetTransport(dlg.Dialog.InviteRequest.Transport())
	}
	return bye, nil
}

// Compile-time guard against unused imports during incremental builds.
var _ = errors.New
