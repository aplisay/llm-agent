package rtp

import (
	"sort"
	"sync"

	"github.com/rs/zerolog/log"
)

// resyncWindow bounds discontinuities before signed 16-bit sequence comparisons alias; ordinary jitter stays
// buffered. Re-prime on large jumps or excess depth to avoid permanent silence and unbounded growth; see PR #285.
const resyncWindow = 3000

// maxDepth bounds audio retained when the consumer stalls; resync instead of accumulating latency. See PR #285.
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
		// Re-prime after discontinuity or a stalled consumer: advancing one slot per tick cannot catch up. See PR #285.
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
