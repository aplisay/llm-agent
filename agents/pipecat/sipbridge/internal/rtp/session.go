// Package rtp manages a single RTP session: a UDP socket pair, RTP
// framing on send, demuxing on receive, plus a small jitter buffer for
// inbound packets.
//
// Scope (Phase A): G.711 only (PT 0 = PCMU, PT 8 = PCMA), 20 ms ptime
// (160 samples / 160 bytes per packet at 8 kHz), unicast-only, no SRTP,
// no SSRC collision handling, no RTCP. These limits are explicit in
// internal/sip/sdp.go's offer/answer and revisited when Opus / G.722 /
// SRTP land.
package rtp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"
	srtpv3 "github.com/pion/srtp/v3"
	"github.com/rs/zerolog/log"
)

// PayloadType identifies the RTP payload encoding. We only care about
// PCMU (0) and PCMA (8) on the inbound Phase A path; we never send any
// other PT.
type PayloadType uint8

const (
	PayloadPCMU PayloadType = 0
	PayloadPCMA PayloadType = 8

	// 8 kHz, 20 ms framing — 160 samples per packet.
	sampleRate8k      = 8000
	packetSamples20ms = 160

	// RTP timestamp increment per packet at 8 kHz / 20 ms.
	tsIncrement = 160

	// Outbound RFC 4733 DTMF (telephone-event) shaping. One event packet
	// is emitted per RTP ptime; each digit plays for dtmfToneMs then a
	// dtmfGapMs silence precedes the next. dtmfVolume is the dBm0 magnitude
	// (0-63). The closing End-bit packet is repeated dtmfEndRepeat times so
	// a single lost packet doesn't strand the event open (RFC 4733 §2.5.1.3).
	dtmfPacketMs      = 20
	dtmfSamplesPerPkt = sampleRate8k * dtmfPacketMs / 1000 // 160 samples @ 8 kHz
	dtmfToneMs        = 200
	dtmfGapMs         = 80
	dtmfVolume        = 10
	dtmfEndRepeat     = 3
)

// Session is a single bidirectional RTP flow for one SIP call.
//
// Lifecycle:
//
//	s, err := rtp.NewSession(bindIP, ...)              // binds the UDP socket
//	s.SetRemote(remoteIP, remotePort)                  // from SDP answer
//	s.SetPayloadType(rtp.PayloadPCMU)                  // negotiated codec
//	s.OnAudio = func(samples []int16) { ... }          // inbound callback
//	s.Start(ctx)                                       // spawns read loop
//	...
//	s.SendAudio(samples)                                // outbound payload
//	...
//	s.Close()
//
// The session does not do its own codec encode/decode — callers feed
// raw codec bytes via SendPayload and receive raw codec bytes via the
// payload handler. The codec package decodes/encodes; the call manager
// wires the two together.
type Session struct {
	conn       *net.UDPConn
	localAddr  *net.UDPAddr
	remoteAddr atomic.Pointer[net.UDPAddr]

	payloadType atomic.Uint32 // stored as uint32 because no atomic.Uint8

	// dtmfPayloadType is the payload type used for outbound RFC 4733
	// telephone-event packets. Defaults to PayloadDTMF (101) — what we
	// advertise in our own SDP and accept on receive; a caller may override
	// it with the peer's negotiated telephone-event rtpmap if it differs.
	dtmfPayloadType atomic.Uint32
	// dtmfMu serialises outbound DTMF bursts so overlapping SendTelephoneEvent
	// calls don't interleave events on the shared SSRC. It does NOT block the
	// audio SendPayload path (only DTMF sends contend on it).
	dtmfMu sync.Mutex
	// dtmfSending is true for the duration of a SendTelephoneEvent burst.
	// Read by CanFill so the pacer's silence fill doesn't splice audio
	// frames into a contiguous RFC 4733 event stream.
	dtmfSending atomic.Bool

	// onPayload receives raw decoded RTP payloads (one packet worth at
	// a time) plus the sequence number (for the jitter buffer to
	// reorder by) and marker bit. The codec package is responsible
	// for turning these into PCM samples; we keep RTP and codec
	// separated so an upcoming Opus addition (variable-size frames at
	// 48 kHz) is a payload-side change only, no RTP-layer rework.
	onPayload func(pt PayloadType, seq uint16, payload []byte, marker bool)

	// Outbound sequence + timestamp state. RFC 3550 says these should
	// be random on session start to defeat third-party injection of
	// spoofed packets.
	seq  atomic.Uint32 // wraps via uint16 in writeRTP
	ts   atomic.Uint32
	ssrc uint32

	// SRTP contexts, set via SetSRTPContexts when the call negotiated
	// encrypted media (SDES or DTLS-SRTP). pion's contexts are
	// unidirectional, so we keep one for each direction. Both are nil
	// for plaintext sessions; one without the other is a configuration
	// bug (rejected by SetSRTPContexts).
	//
	// Held under srtpMu — DTLS-SRTP installs them asynchronously after
	// the SIP 200 OK, so a packet may arrive before the contexts land;
	// readLoop holds the lock briefly to read the current pair.
	srtpMu       sync.RWMutex
	srtpInbound  *srtpv3.Context
	srtpOutbound *srtpv3.Context

	mu     sync.Mutex
	closed bool
	cancel context.CancelFunc

	// srtpFailures / rtpFailures count consecutive decrypt and parse
	// failures on the read loop. Both are per-packet events: a carrier
	// that negotiates RTP/SAVP and then sends plaintext (see the
	// srtpAvoid comment in the call manager) produces 50 of them a
	// second for the whole call, so the log lines are rate-limited and
	// the leg is torn down once the failures are clearly permanent
	// rather than a transient key/replay hiccup. Read-loop-local, no
	// lock needed.
	srtpFailures int
	rtpFailures  int
}

// maxConsecutiveSRTPFailures is how many back-to-back undecryptable
// packets (~2 s at 20 ms ptime) we accept before concluding the media
// key is simply wrong and stopping the read loop. Anything transient —
// a replayed packet, one bad auth tag — resets the count on the next
// good packet.
const maxConsecutiveSRTPFailures = 100

// mediaFailureLogEvery rate-limits the per-packet failure warnings to
// the 1st, then every 250th (~5 s of audio), mirroring the pacer's
// dropped-audio logging.
const mediaFailureLogEvery = 250

// NewSession binds a UDP socket for RTP. The OS picks a free port from
// the configured range (caller passes bindIP + 0); the call manager
// publishes (localIP, port) in the SDP offer/answer.
//
// portMin / portMax narrow the OS's range to a documented range so
// firewall rules can be static. Pass (0, 0) to let the OS choose any
// free port — handy for tests, but in production we want a fixed range.
func NewSession(bindIP string, portMin, portMax int) (*Session, error) {
	conn, err := pickPort(bindIP, portMin, portMax)
	if err != nil {
		return nil, fmt.Errorf("rtp: pick port: %w", err)
	}
	s := &Session{
		conn:      conn,
		localAddr: conn.LocalAddr().(*net.UDPAddr),
		ssrc:      rand.Uint32(),
	}
	// RFC 3550 §5.1: random initial seq + timestamp.
	s.seq.Store(uint32(rand.Intn(0xFFFF)))
	s.ts.Store(rand.Uint32())
	s.dtmfPayloadType.Store(uint32(PayloadDTMF))
	return s, nil
}

// LocalAddr returns the bound (IP, port) for the SDP m= line.
func (s *Session) LocalAddr() *net.UDPAddr { return s.localAddr }

// SetRemote sets the far-end RTP address from the SDP answer. It can
// be called again on a re-INVITE (hold/unhold) to redirect the audio.
func (s *Session) SetRemote(ip string, port int) error {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(ip, fmt.Sprintf("%d", port)))
	if err != nil {
		return fmt.Errorf("rtp: resolve remote: %w", err)
	}
	s.remoteAddr.Store(addr)
	return nil
}

// SetPayloadType selects the codec we'll emit on outbound RTP. Inbound
// PT is whatever the far end sends — we currently accept both 0 (PCMU)
// and 8 (PCMA) and route to the payload handler tagged appropriately.
func (s *Session) SetPayloadType(pt PayloadType) {
	s.payloadType.Store(uint32(pt))
}

// SetPayloadHandler registers the inbound callback. Called from the
// read loop goroutine; the handler should be quick (push-into-buffer
// fast) or hand off to its own goroutine.
//
// Receives the SIP sequence number (16-bit, wraps) so the consumer
// can reorder via a jitter buffer.
func (s *Session) SetPayloadHandler(fn func(pt PayloadType, seq uint16, payload []byte, marker bool)) {
	s.onPayload = fn
}

// Start spawns the read goroutine. The context cancellation is the
// signal to exit cleanly; the socket is also closed by Close().
func (s *Session) Start(ctx context.Context) {
	rctx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	closed := s.closed
	s.cancel = cancel
	s.mu.Unlock()
	if closed {
		// Close ran before Start (the DTLS handshake path starts the
		// loop asynchronously, and a failed call can be torn down
		// first). Don't spawn a read loop on a dead socket.
		cancel()
		return
	}
	go s.readLoop(rctx)
}

// SetSRTPContexts installs the SRTP encryption/decryption contexts.
// Both must be non-nil (encryption is bidirectional in this stack);
// passing one without the other is rejected to make the half-encrypted
// state impossible. Safe to call concurrently with the read loop —
// readLoop / SendPayload pick up the new contexts on the next packet.
//
// Used by the call manager once SDES has been negotiated in SDP, or
// once a DTLS-SRTP handshake has completed and we've derived the per-
// direction master keys from the keying-material export.
func (s *Session) SetSRTPContexts(inbound, outbound *srtpv3.Context) error {
	if (inbound == nil) != (outbound == nil) {
		return errors.New("rtp: SetSRTPContexts: must set both inbound and outbound, or neither")
	}
	s.srtpMu.Lock()
	s.srtpInbound = inbound
	s.srtpOutbound = outbound
	s.srtpMu.Unlock()
	return nil
}

// IsEncrypted reports whether SRTP contexts are currently installed.
// Used by the call manager for logging / metric tagging.
func (s *Session) IsEncrypted() bool {
	s.srtpMu.RLock()
	defer s.srtpMu.RUnlock()
	return s.srtpOutbound != nil
}

// writeRTP frames a payload with the given payload type, RTP timestamp and
// marker bit, assigns the next sequence number, applies SRTP if installed,
// and sends it. SendPayload (audio) and SendTelephoneEvent (DTMF) share it,
// so both advance the one outbound sequence-number space on the single SSRC.
//
// If an outbound SRTP context is installed, the marshalled RTP packet is
// encrypted via SRTP before going on the wire.
func (s *Session) writeRTP(pt uint8, ts uint32, marker bool, payload []byte) error {
	remote := s.remoteAddr.Load()
	if remote == nil {
		return errors.New("rtp: remote address not yet set")
	}
	pkt := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			Marker:         marker,
			PayloadType:    pt,
			SequenceNumber: uint16(s.seq.Add(1)),
			Timestamp:      ts,
			SSRC:           s.ssrc,
		},
		Payload: payload,
	}
	buf, err := pkt.Marshal()
	if err != nil {
		return fmt.Errorf("rtp: marshal: %w", err)
	}
	s.srtpMu.RLock()
	out := s.srtpOutbound
	s.srtpMu.RUnlock()
	if out != nil {
		buf, err = out.EncryptRTP(nil, buf, nil)
		if err != nil {
			return fmt.Errorf("rtp: SRTP encrypt: %w", err)
		}
	}
	if _, err := s.conn.WriteToUDP(buf, remote); err != nil {
		return fmt.Errorf("rtp: write: %w", err)
	}
	return nil
}

// SendPayload wraps an already-encoded codec payload in an RTP header
// and sends it. Caller provides the codec bytes (e.g. 160 bytes of
// PCMU); we add the RTP framing + sequence/ts and ship it.
func (s *Session) SendPayload(payload []byte) error {
	return s.writeRTP(uint8(s.payloadType.Load()), s.ts.Add(tsIncrement), false, payload)
}

// SendPayloadPaced is SendPayload for a paced stream: the packet's sampling
// instant is gapFrames whole frames after the previous packet (0 = the
// previous 20 ms slot), so the RTP timestamp tracks the wall clock across any
// slot the pacer chose not to transmit; marker flags the first packet of a
// talkspurt (RFC 3550 §5.1). Shares the sequence/ts space with SendPayload and
// SendTelephoneEvent.
func (s *Session) SendPayloadPaced(payload []byte, gapFrames uint32, marker bool) error {
	return s.writeRTP(uint8(s.payloadType.Load()), s.ts.Add(tsIncrement*(1+gapFrames)), marker, payload)
}

// HasRemote reports whether the peer's media address is known yet. Sending
// before it is set is a guaranteed error (see writeRTP), so callers that
// transmit on a timer rather than in response to real audio must gate on it.
func (s *Session) HasRemote() bool {
	return s.remoteAddr.Load() != nil
}

// CanFill reports whether it is safe to transmit a filler audio frame right
// now: the peer's address is known and no RFC 4733 DTMF burst is in flight.
func (s *Session) CanFill() bool {
	return s.HasRemote() && !s.dtmfSending.Load()
}

// SilencePayload returns one 20 ms frame of digital silence in whatever codec
// is currently selected for egress: 0xFF for PCMU, 0xD5 for PCMA — the G.711
// encodings of zero amplitude. Used to keep the outbound stream continuous
// while the bot has nothing to say (see the pacer's fill mode). A SIP UA is
// expected to transmit every 20 ms for the life of the call whether or not
// anyone is talking; peers with a media watchdog read a gap as a dead call.
func (s *Session) SilencePayload() []byte {
	if PayloadType(s.payloadType.Load()) == PayloadPCMA {
		return silencePCMA
	}
	return silencePCMU
}

// Pre-built silence frames. The pacer asks for one every 20 ms for
// every idle call; building it each time was 160 bytes of garbage per
// call per frame for no reason. Callers only hand these to the
// encrypt/send path, which does not retain or mutate them.
var (
	silencePCMU = bytes.Repeat([]byte{0xFF}, packetSamples20ms)
	silencePCMA = bytes.Repeat([]byte{0xD5}, packetSamples20ms)
)

// SetDTMFPayloadType overrides the payload type used for outbound RFC 4733
// telephone-event packets (default PayloadDTMF / 101). A caller that has
// parsed the peer's telephone-event rtpmap may install the negotiated value
// when it differs from ours.
func (s *Session) SetDTMFPayloadType(pt PayloadType) {
	s.dtmfPayloadType.Store(uint32(pt))
}

// SendTelephoneEvent plays a string of DTMF digits to the far end as
// out-of-band RFC 4733 telephone-event RTP, interleaved on this session's
// outbound SSRC (payload type from SetDTMFPayloadType, default 101).
//
// Each digit is a burst of packets that share one RTP timestamp (the event's
// start), with the marker bit set on the first packet and the cumulative
// sample count carried in the event's duration field; the closing End-bit
// packet is repeated for loss resilience, then an inter-digit gap precedes
// the next. The shared timestamp clock is advanced past each event + gap so
// concurrent audio and subsequent digits stay monotonic. Characters outside
// 0-9, * and # are skipped with a warning.
//
// Blocks for the full burst (~280 ms/digit); serialised per session so
// overlapping requests don't interleave events. A closed socket surfaces as
// a write error that aborts the remaining digits.
func (s *Session) SendTelephoneEvent(ctx context.Context, digits string) error {
	if s.remoteAddr.Load() == nil {
		return errors.New("rtp: remote address not yet set")
	}
	s.dtmfMu.Lock()
	defer s.dtmfMu.Unlock()
	// Hold off silence fill for the duration of the burst: an RFC 4733 event
	// is a contiguous run of packets sharing one timestamp, and splicing
	// audio frames into it can confuse a receiver's digit detector. Real bot
	// audio was always allowed to interleave here, but it is rare mid-burst
	// whereas fill would be continuous.
	s.dtmfSending.Store(true)
	defer s.dtmfSending.Store(false)

	pt := uint8(s.dtmfPayloadType.Load())
	tonesPerDigit := dtmfToneMs / dtmfPacketMs
	for i := 0; i < len(digits); i++ {
		event, ok := EventCode(digits[i])
		if !ok {
			log.Warn().Str("char", string(digits[i])).Msg("rtp: skipping non-DTMF character in SendTelephoneEvent")
			continue
		}
		startTS := s.ts.Load()
		var duration uint16
		for p := 0; p < tonesPerDigit; p++ {
			duration = uint16((p + 1) * dtmfSamplesPerPkt)
			if err := s.writeRTP(pt, startTS, p == 0, EncodeDTMF(event, false, dtmfVolume, duration)); err != nil {
				return err
			}
			if err := sleepCtx(ctx, dtmfPacketMs*time.Millisecond); err != nil {
				return err
			}
		}
		endPayload := EncodeDTMF(event, true, dtmfVolume, duration)
		for r := 0; r < dtmfEndRepeat; r++ {
			if err := s.writeRTP(pt, startTS, false, endPayload); err != nil {
				return err
			}
		}
		// Move the shared timestamp clock past this event + the inter-digit
		// gap so the next digit (and any interleaved audio) starts later.
		s.ts.Add(uint32(int(duration) + dtmfGapMs*sampleRate8k/1000))
		if err := sleepCtx(ctx, dtmfGapMs*time.Millisecond); err != nil {
			return err
		}
	}
	return nil
}

// sleepCtx sleeps for d, returning early with the context error if ctx is
// cancelled (e.g. the call is torn down mid-burst).
func sleepCtx(ctx context.Context, d time.Duration) error {
	if ctx == nil {
		time.Sleep(d)
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Close ends the read loop and releases the UDP socket. Safe to call
// multiple times.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_ = s.conn.Close()
}

func (s *Session) readLoop(ctx context.Context) {
	buf := make([]byte, 1500) // MTU-sized
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		// SetReadDeadline lets us notice context cancellation between
		// packets without leaking the goroutine on a long-quiet remote.
		_ = s.conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, _, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			if errors.Is(err, net.ErrClosed) || errors.Is(err, context.Canceled) {
				return
			}
			log.Warn().Err(err).Msg("rtp: read error")
			return
		}
		// If SRTP is installed, decrypt before parsing the RTP header.
		// pion's DecryptRTP allocates a fresh buffer for the plaintext,
		// so we don't need to worry about aliasing ``buf``.
		raw := buf[:n]
		s.srtpMu.RLock()
		in := s.srtpInbound
		s.srtpMu.RUnlock()
		if in != nil {
			pt, err := in.DecryptRTP(nil, raw, nil)
			if err != nil {
				s.srtpFailures++
				if s.srtpFailures == 1 || s.srtpFailures%mediaFailureLogEvery == 0 {
					log.Warn().Err(err).
						Int("len", n).
						Int("consecutive", s.srtpFailures).
						Msg("rtp: SRTP decrypt failed (auth tag / replay / wrong key?)")
				}
				if s.srtpFailures >= maxConsecutiveSRTPFailures {
					// Every packet since the key was installed has
					// failed: this is not jitter, the key is wrong (or
					// the peer is sending plaintext into an SAVP
					// session). Stop; the media watchdog then tears the
					// call down as a silent leg rather than us burning
					// a core on decrypt failures for its whole life.
					log.Error().
						Int("consecutive", s.srtpFailures).
						Msg("rtp: too many consecutive SRTP failures — stopping read loop")
					return
				}
				continue
			}
			s.srtpFailures = 0
			raw = pt
		}
		pkt := &pionrtp.Packet{}
		if err := pkt.Unmarshal(raw); err != nil {
			s.rtpFailures++
			if s.rtpFailures == 1 || s.rtpFailures%mediaFailureLogEvery == 0 {
				log.Warn().Err(err).
					Int("len", len(raw)).
					Int("consecutive", s.rtpFailures).
					Msg("rtp: malformed packet")
			}
			continue
		}
		s.rtpFailures = 0
		if s.onPayload != nil {
			s.onPayload(PayloadType(pkt.PayloadType), pkt.SequenceNumber, pkt.Payload, pkt.Marker)
		}
	}
}

// pickPort returns an even free UDP port in [portMin, portMax]. RTP
// convention is even-numbered ports (RTCP uses port+1 if we ever add
// it); we don't need RTCP yet but we keep the even-port convention so
// adding it later doesn't break the SDP we've published. If portMin ==
// 0 the OS picks any free port (test-only path).
// pickPort returns a bound socket on an even free port, not just the
// number. Returning the number and rebinding in the caller was a
// time-of-check/time-of-use race: under any concurrency a second call
// could take the port between the probe's Close and the caller's
// ListenUDP, failing the INVITE with a 500. Keeping the socket also
// removes up to (max-min)/2 bind/close syscalls per call when the
// range is nearly full.
func pickPort(bindIP string, portMin, portMax int) (*net.UDPConn, error) {
	if portMin == 0 && portMax == 0 {
		return net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(bindIP)})
	}
	// Start at an odd offset within the range so concurrent calls don't
	// keep colliding on the same first-attempt port.
	offset := rand.Intn((portMax-portMin)/2 + 1)
	for i := 0; i < (portMax-portMin)/2+1; i++ {
		p := portMin + ((i+offset)%((portMax-portMin)/2+1))*2
		if p&1 == 1 {
			p++ // align to even
		}
		l, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(bindIP), Port: p})
		if err == nil {
			return l, nil
		}
	}
	return nil, fmt.Errorf("rtp: no free even port in %d-%d", portMin, portMax)
}
