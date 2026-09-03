package rtp

import (
	"sort"
	"sync"

	"github.com/rs/zerolog/log"
)

// JitterBuffer reorders incoming RTP packets by sequence number and
// releases them on a fixed 20 ms cadence to smooth out network jitter
// and absorb small amounts of reordering.
//
// Design notes:
//
//   - Target depth: ~60 ms (3 packets at 20 ms ptime). Chosen as a
//     trade-off between latency added to the bot's response (lower is
//     better for conversational flow) and tolerance for late/reordered
//     packets (higher is better). 60 ms is on the low end of what's
//     typically used in VoIP; we can dial it up via the Depth knob if
//     production traffic shows audible gaps.
//
//   - PLC strategy: when a sequence-number gap is detected at release
//     time, emit a zero-payload (silence) packet of the same length
//     to the consumer. The codec layer treats a missing PCMU/PCMA
//     payload as 20 ms of silence and the consumer gets a clean,
//     consistent stream. A fancier PLC (G.711 packet-loss concealment
//     algorithm) could repeat / pitch-shift the last good packet but
//     20 ms of silence is plenty for occasional carrier hiccups.
//
//   - Sequence-number rollover: handled by treating the running
//     ``next`` cursor modulo 2^16 and using the signed 16-bit diff
//     (``int16(a - b)``) for ordering. Standard RTP trick.
//
//   - Late packets (older than the current cursor) are dropped — by
//     the time we've moved past their slot the consumer has already
//     received either the packet that arrived in time or the silence
//     stub.
//
//   - Discontinuity: a stream that jumps its sequence numbers (an SSRC
//     change after a transfer or music-on-hold, RTCP-mux junk parsed as
//     RTP) would otherwise leave the release cursor thousands of slots
//     behind the arriving packets — silence out, unbounded map growth
//     in, and no recovery. Push resyncs (Reset + re-prime) when the
//     distance from the cursor leaves ``resyncWindow`` or the map
//     exceeds ``maxDepth``. A backward jump past 32 767 aliases to
//     "late" and would otherwise drop every packet for good; the same
//     window catches it.
//
// The buffer is not used in relay mode (Phase C bridged transfer) —
// the relay forwards packets immediately without ordering, since both
// legs see whatever jitter the bridge sees and there's no benefit to
// reordering twice.
// resyncWindow is how far (in packets, either direction) an arriving
// sequence number may be from the release cursor before we treat the
// stream as discontinuous rather than merely jittery. 3 000 packets is
// a minute of 20 ms audio — far beyond any real reordering or loss
// burst, and well clear of the ±32 767 point where the signed-16-bit
// comparison aliases.
const resyncWindow = 3000

// maxDepth caps the number of buffered packets. At the 3-packet target
// depth the release loop keeps this near zero; reaching 250 (5 s) means
// the consumer has stalled or the stream is discontinuous, and holding
// more just adds latency that never drains.
const maxDepth = 250

type JitterBuffer struct {
	// Depth is the target queue length in packets. Filled at
	// construction; consumed each Tick.
	Depth int

	// PayloadSize is the expected codec-payload length per packet
	// (160 bytes for PCMU/PCMA at 20 ms). Used when we need to
	// fabricate a silence packet for PLC.
	PayloadSize int

	mu      sync.Mutex
	packets map[uint16][]byte
	next    uint16 // next sequence number to release
	primed  bool   // false until the first packet arrives
}

// NewJitterBuffer returns an empty buffer with the supplied target
// depth (in packets). Pass 3 for the standard 60 ms target at 20 ms
// ptime.
func NewJitterBuffer(depth, payloadSize int) *JitterBuffer {
	return &JitterBuffer{
		Depth:       depth,
		PayloadSize: payloadSize,
		packets:     make(map[uint16][]byte),
	}
}

// Push enqueues an inbound RTP payload by sequence number.
// Out-of-order arrivals fit naturally into the map; very-late packets
// (older than the current release cursor) are dropped.
func (j *JitterBuffer) Push(seq uint16, payload []byte) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.primed {
		j.next = seq
		j.primed = true
	} else if d := int16(seq - j.next); d > resyncWindow || d < -resyncWindow || len(j.packets) >= maxDepth {
		// Discontinuity: the stream has jumped (new SSRC, non-RTP junk)
		// or the consumer has stalled. Either way the cursor can never
		// catch up on its own — one slot per 20 ms tick — so start
		// over from this packet. Dropping what we hold costs at most
		// the buffered audio; not resyncing costs the rest of the call.
		log.Warn().
			Uint16("seq", seq).
			Uint16("next", j.next).
			Int("depth", len(j.packets)).
			Msg("rtp: jitter buffer discontinuity — resyncing")
		j.packets = map[uint16][]byte{}
		j.next = seq
	} else if d < 0 {
		// Already-released slot — drop. Logging at debug because over
		// a reordered network this is normal.
		log.Debug().
			Uint16("seq", seq).
			Uint16("next", j.next).
			Msg("rtp: dropping late packet")
		return
	}
	// Copy the payload because the caller's buffer may be reused
	// across reads.
	cp := make([]byte, len(payload))
	copy(cp, payload)
	j.packets[seq] = cp
}

// Pop releases the next packet (in sequence order) if the buffer has
// reached its target depth. Returns (payload, gap) where ``gap`` is
// true if a sequence-number gap was filled with synthesised silence.
// Returns (nil, false) if the buffer hasn't reached target depth yet.
func (j *JitterBuffer) Pop() ([]byte, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.primed || len(j.packets) < j.Depth {
		return nil, false
	}
	payload, ok := j.packets[j.next]
	if ok {
		delete(j.packets, j.next)
		j.next++
		return payload, false
	}
	// Gap: synthesise silence and advance.
	j.next++
	return make([]byte, j.PayloadSize), true
}

// Len returns the number of packets currently buffered (the field
// ``Depth`` is the *target*, not the current occupancy). Used by the
// release loop to detect a buffer that has run above target (a stalled
// consumer or a burst) so it can drain the excess rather than carry it
// as permanent added latency.
func (j *JitterBuffer) Len() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return len(j.packets)
}

// Flush drains the buffer in sequence order, returning everything
// currently held. Used at end-of-call so callers can finalise codec
// state without leaving fragments behind.
func (j *JitterBuffer) Flush() [][]byte {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.primed {
		return nil
	}
	keys := make([]uint16, 0, len(j.packets))
	for k := range j.packets {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool {
		return int16(keys[a]-keys[b]) < 0
	})
	out := make([][]byte, 0, len(keys))
	for _, k := range keys {
		out = append(out, j.packets[k])
	}
	j.packets = map[uint16][]byte{}
	return out
}

// Reset clears the buffer back to its un-primed state. Used when the
// codec or remote endpoint changes (e.g. re-INVITE / hold release).
func (j *JitterBuffer) Reset() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.packets = map[uint16][]byte{}
	j.primed = false
}
