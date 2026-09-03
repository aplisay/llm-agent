package rtp

import "testing"

// The jitter buffer's release cursor advances one slot per 20 ms tick.
// A stream whose sequence numbers jump — a new SSRC after a transfer or
// music-on-hold, RTCP-mux junk parsed as RTP — leaves the cursor
// thousands of slots behind the arrivals, and it can never catch up on
// its own: silence out, unbounded map growth in. Push must resync.

func TestPushResyncsOnForwardDiscontinuity(t *testing.T) {
	jb := NewJitterBuffer(3, 160)
	for i := 0; i < 5; i++ {
		jb.Push(uint16(1000+i), []byte{byte(i)})
	}
	// A jump well beyond any real reordering or loss burst.
	jb.Push(40000, []byte{0xAA})
	if got := jb.Len(); got != 1 {
		t.Fatalf("Len after discontinuity = %d; want 1 (buffer re-primed on the new stream)", got)
	}
	payload, gap := jb.Pop()
	if payload != nil || gap {
		t.Fatalf("Pop below target depth = (%v,%v); want (nil,false)", payload, gap)
	}
	jb.Push(40001, []byte{0xBB})
	jb.Push(40002, []byte{0xCC})
	payload, gap = jb.Pop()
	if gap || len(payload) != 1 || payload[0] != 0xAA {
		t.Fatalf("Pop after resync = (%v,%v); want the first packet of the new stream", payload, gap)
	}
}

// A backward jump past 32 767 aliases to "late" under the signed-16-bit
// comparison, which without the window would drop every packet for the
// rest of the call.
func TestPushResyncsOnBackwardDiscontinuity(t *testing.T) {
	jb := NewJitterBuffer(3, 160)
	for i := 0; i < 3; i++ {
		jb.Push(uint16(40000+i), []byte{byte(i)})
	}
	jb.Push(100, []byte{0xAA})
	if got := jb.Len(); got != 1 {
		t.Fatalf("Len after backward discontinuity = %d; want 1", got)
	}
}

// Ordinary reordering must NOT trip the resync: a packet a few slots
// early is exactly what the buffer exists to absorb.
func TestPushKeepsSmallReordering(t *testing.T) {
	jb := NewJitterBuffer(3, 160)
	jb.Push(1000, []byte{1})
	jb.Push(1003, []byte{4}) // 3 ahead — normal jitter
	jb.Push(1001, []byte{2})
	jb.Push(1002, []byte{3})
	if got := jb.Len(); got != 4 {
		t.Fatalf("Len = %d; want 4 (no resync for small reordering)", got)
	}
	// Pop drains only while occupancy is at or above the target depth
	// of 3, so 4 buffered packets yield 2 releases — in sequence order,
	// which is the point: the out-of-order arrival was slotted right.
	for want := byte(1); want <= 2; want++ {
		payload, gap := jb.Pop()
		if gap || len(payload) != 1 || payload[0] != want {
			t.Fatalf("Pop #%d = (%v,%v); want payload %d in sequence order", want, payload, gap, want)
		}
	}
}

// A stalled consumer must not accumulate unbounded latency.
func TestPushCapsDepth(t *testing.T) {
	jb := NewJitterBuffer(3, 160)
	for i := 0; i < maxDepth+50; i++ {
		jb.Push(uint16(1000+i), []byte{byte(i)})
	}
	if got := jb.Len(); got > maxDepth {
		t.Fatalf("Len = %d; want <= maxDepth (%d)", got, maxDepth)
	}
}

// Late packets (behind the cursor but inside the window) are still
// dropped rather than resyncing the stream.
func TestPushDropsLatePackets(t *testing.T) {
	jb := NewJitterBuffer(1, 160)
	jb.Push(1000, []byte{1})
	if p, _ := jb.Pop(); p == nil {
		t.Fatal("Pop returned nil at target depth 1")
	}
	jb.Push(999, []byte{9}) // already released
	if got := jb.Len(); got != 0 {
		t.Fatalf("Len = %d; want 0 (late packet dropped, not resynced)", got)
	}
}
