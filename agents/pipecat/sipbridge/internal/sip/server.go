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
// The call manager registers the handler in call.Manager.RegisterSIP().
type InviteHandler func(ctx context.Context, callID string, offer *CodecOffer, headers IncomingHeaders) (sdpAnswer []byte, err error)

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
	signalIP string
	signalPort int
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

// Config controls how the server binds and presents itself on the wire.
type Config struct {
	// SignalIP is the IP advertised in the Contact / Via headers — the
	// upstream B2BUA will route ACK/BYE back here. With host networking
	// inside our LAN this is usually the same as BindIP.
	SignalIP string
	// SignalPort is the SIP port to listen on (UDP). Default 5060.
	SignalPort int
	// BindIP is the address to bind the UDP listener to. Defaults to
	// SignalIP if empty.
	BindIP string
	// UserAgent string sent in the User-Agent / Server header.
	UserAgent string
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

	ua, err := sipgo.NewUA(
		sipgo.WithUserAgent(cfg.UserAgent),
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
	}

	s := &Server{
		ua:         ua,
		srv:        srv,
		ub:         dua,
		calls:      make(map[string]*activeCall),
		signalIP:   cfg.SignalIP,
		signalPort: cfg.SignalPort,
	}
	s.registerHandlers()
	return s, nil
}

// SetInviteHandler registers the per-call setup handler.
func (s *Server) SetInviteHandler(h InviteHandler) { s.invite = h }

// SetByeHandler registers the per-call teardown handler.
func (s *Server) SetByeHandler(h ByeHandler) { s.bye = h }

// Listen binds the UDP socket and starts the SIP transaction loop.
// Returns when the context is cancelled or the listener errors fatally.
func (s *Server) Listen(ctx context.Context) error {
	addr := net.JoinHostPort(s.signalIP, fmt.Sprintf("%d", s.signalPort))
	log.Info().Str("addr", addr).Msg("sip: listening (UDP)")
	return s.srv.ListenAndServe(ctx, "udp", addr)
}

// ListenTLS binds an additional TCP/TLS listener (SIPS, port 5061 by
// convention). Carriers / B2BUAs targeting SIPS use this; the UDP
// listener stays up in parallel for non-TLS peers.
//
// ``certFile`` and ``keyFile`` are PEM-encoded paths. We load them
// once at startup; cert rotation requires a restart for v1. A future
// pass can switch to a watching reloader if zero-downtime cert refresh
// becomes operationally interesting.
func (s *Server) ListenTLS(ctx context.Context, port int, certFile, keyFile string) error {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("sip: load TLS cert/key: %w", err)
	}
	cfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}
	addr := net.JoinHostPort(s.signalIP, fmt.Sprintf("%d", port))
	log.Info().Str("addr", addr).Msg("sip: listening (TLS)")
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
}

func (s *Server) onInvite(req *sip.Request, tx sip.ServerTransaction) {
	callID := req.CallID().Value()
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
	_ = tx.Respond(sip.NewResponseFromRequest(req, 100, "Trying", nil))

	answer, err := s.invite(context.Background(), callID, offer, headers)
	if err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: invite handler rejected")
		s.respond(req, tx, 500, "Server Error", nil)
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

	// 200 OK with our SDP answer. Content-Type must be application/sdp
	// (sipgo doesn't set this automatically when we use
	// NewResponseFromRequest + SetBody).
	resp := sip.NewResponseFromRequest(req, 200, "OK", answer)
	resp.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	// Add a Contact so subsequent in-dialog requests (ACK, BYE, re-
	// INVITE) target our SignalIP:SignalPort directly.
	resp.AppendHeader(&sip.ContactHeader{
		Address: sip.Uri{
			User: "sipbridge",
			Host: s.signalIP,
			Port: s.signalPort,
		},
	})
	if err := tx.Respond(resp); err != nil {
		log.Warn().Err(err).Str("call_id", callID).Msg("sip: failed to send 200 OK")
		s.cleanupCall(callID)
		return
	}
	log.Info().
		Str("call_id", callID).
		Str("from", headers.From).
		Str("to", headers.To).
		Msg("sip: INVITE answered")
}

func (s *Server) onAck(req *sip.Request, tx sip.ServerTransaction) {
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
	callID := req.CallID().Value()
	s.mu.Lock()
	c := s.calls[callID]
	s.mu.Unlock()
	if c == nil {
		// Unknown dialog — respond 200 anyway so the far end stops
		// retransmitting (some carriers re-send BYE after a missed
		// ACK).
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
	if err := tx.Respond(resp); err != nil {
		log.Warn().Err(err).Int("code", code).Msg("sip: respond failed")
	}
}

func extractHeaders(req *sip.Request) IncomingHeaders {
	h := IncomingHeaders{Extra: map[string]string{}}
	if f := req.From(); f != nil {
		h.From = f.Address.String()
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
	for k, v := range customHeaders {
		extra = append(extra, sip.NewHeader(k, v))
	}

	dlg, err := s.ub.Invite(ctx, targetURI, sdpOffer, extra...)
	if err != nil {
		return nil, nil, fmt.Errorf("sip: Invite: %w", err)
	}

	// WaitAnswer blocks for the final response. Provisional responses
	// (100 Trying / 180 Ringing) are consumed internally.
	if err := dlg.WaitAnswer(ctx, sipgo.AnswerOptions{}); err != nil {
		_ = dlg.Close()
		return nil, nil, fmt.Errorf("sip: WaitAnswer: %w", err)
	}
	resp := dlg.InviteResponse
	if resp == nil || !resp.IsSuccess() {
		_ = dlg.Close()
		code := 0
		if resp != nil {
			code = int(resp.StatusCode)
		}
		return nil, nil, fmt.Errorf("sip: INVITE final %d", code)
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
		return fmt.Errorf("sip: hangup: unknown call_id %q", callID)
	}
	if c.uas != nil {
		return c.uas.Bye(ctx)
	}
	if c.uac != nil {
		return c.uac.Bye(ctx)
	}
	return nil
}

// Compile-time guard against unused imports during incremental builds.
var _ = errors.New
