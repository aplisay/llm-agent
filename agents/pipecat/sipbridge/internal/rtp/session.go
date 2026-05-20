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
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"
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
	sampleRate8k     = 8000
	packetSamples20ms = 160

	// RTP timestamp increment per packet at 8 kHz / 20 ms.
	tsIncrement = 160
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
	seq atomic.Uint32 // wraps via uint16 in writeRTP
	ts  atomic.Uint32
	ssrc uint32

	mu     sync.Mutex
	closed bool
	cancel context.CancelFunc
}

// NewSession binds a UDP socket for RTP. The OS picks a free port from
// the configured range (caller passes bindIP + 0); the call manager
// publishes (localIP, port) in the SDP offer/answer.
//
// portMin / portMax narrow the OS's range to a documented range so
// firewall rules can be static. Pass (0, 0) to let the OS choose any
// free port — handy for tests, but in production we want a fixed range.
func NewSession(bindIP string, portMin, portMax int) (*Session, error) {
	port, err := pickPort(bindIP, portMin, portMax)
	if err != nil {
		return nil, fmt.Errorf("rtp: pick port: %w", err)
	}
	local := &net.UDPAddr{IP: net.ParseIP(bindIP), Port: port}
	conn, err := net.ListenUDP("udp", local)
	if err != nil {
		return nil, fmt.Errorf("rtp: listen on %s: %w", local, err)
	}
	s := &Session{
		conn:      conn,
		localAddr: conn.LocalAddr().(*net.UDPAddr),
		ssrc:      rand.Uint32(),
	}
	// RFC 3550 §5.1: random initial seq + timestamp.
	s.seq.Store(uint32(rand.Intn(0xFFFF)))
	s.ts.Store(rand.Uint32())
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
	s.cancel = cancel
	go s.readLoop(rctx)
}

// SendPayload wraps an already-encoded codec payload in an RTP header
// and sends it. Caller provides the codec bytes (e.g. 160 bytes of
// PCMU); we add the RTP framing + sequence/ts and ship it.
func (s *Session) SendPayload(payload []byte) error {
	remote := s.remoteAddr.Load()
	if remote == nil {
		return errors.New("rtp: remote address not yet set")
	}
	pkt := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    uint8(s.payloadType.Load()),
			SequenceNumber: uint16(s.seq.Add(1)),
			Timestamp:      s.ts.Add(tsIncrement),
			SSRC:           s.ssrc,
		},
		Payload: payload,
	}
	buf, err := pkt.Marshal()
	if err != nil {
		return fmt.Errorf("rtp: marshal: %w", err)
	}
	if _, err := s.conn.WriteToUDP(buf, remote); err != nil {
		return fmt.Errorf("rtp: write: %w", err)
	}
	return nil
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
	s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
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
		pkt := &pionrtp.Packet{}
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			log.Warn().Err(err).Int("len", n).Msg("rtp: malformed packet")
			continue
		}
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
func pickPort(bindIP string, portMin, portMax int) (int, error) {
	if portMin == 0 && portMax == 0 {
		l, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(bindIP)})
		if err != nil {
			return 0, err
		}
		defer l.Close()
		return l.LocalAddr().(*net.UDPAddr).Port, nil
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
			_ = l.Close()
			return p, nil
		}
	}
	return 0, fmt.Errorf("rtp: no free even port in %d-%d", portMin, portMax)
}
