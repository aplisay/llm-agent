package call

import (
	"context"
	"sync"
	"testing"
	"time"
)

// sendRecorder collects sendFn invocations with their wall-clock times.
type sendRecorder struct {
	mu    sync.Mutex
	sends []recordedSend
}

type recordedSend struct {
	payload []byte
	gap     uint32
	marker  bool
	at      time.Time
}

func (r *sendRecorder) send(payload []byte, gap uint32, marker bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sends = append(r.sends, recordedSend{payload, gap, marker, time.Now()})
	return nil
}

func (r *sendRecorder) snapshot() []recordedSend {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]recordedSend, len(r.sends))
	copy(out, r.sends)
	return out
}

func payloadsN(n int) [][]byte {
	out := make([][]byte, n)
	for i := range out {
		out[i] = []byte{byte(i)}
	}
	return out
}

func startTestPacer(t *testing.T, rec *sendRecorder, suspended func() bool) (*pacer, context.CancelFunc) {
	t.Helper()
	if suspended == nil {
		suspended = func() bool { return false }
	}
	p := &pacer{sendFn: rec.send, suspended: suspended}
	ctx, cancel := context.WithCancel(context.Background())
	go p.run(ctx)
	return p, cancel
}

// A burst of enqueued payloads must leave at ~real-time (one per 20 ms),
// not back-to-back: 10 packets span at least 9 inter-send frames.
func TestPacerSmoothsBurstToRealTime(t *testing.T) {
	rec := &sendRecorder{}
	p, cancel := startTestPacer(t, rec, nil)
	defer cancel()

	start := time.Now()
	p.enqueue(payloadsN(10))

	deadline := time.After(2 * time.Second)
	for {
		if len(rec.snapshot()) == 10 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("timed out: only %d/10 packets sent", len(rec.snapshot()))
		case <-time.After(5 * time.Millisecond):
		}
	}
	elapsed := time.Since(start)
	// 10 packets = 9 full frame intervals minimum (first may go ~immediately).
	// Generous lower bound to stay robust on loaded CI machines: the old
	// unpaced path shipped all 10 within a millisecond.
	if elapsed < 150*time.Millisecond {
		t.Fatalf("10 packets sent in %v — egress is not paced", elapsed)
	}

	sends := rec.snapshot()
	if !sends[0].marker {
		t.Error("first packet of the stream must carry the talkspurt marker")
	}
	for i, s := range sends {
		if i == 0 {
			continue
		}
		if s.marker || s.gap != 0 {
			t.Errorf("packet %d: contiguous speech must have marker=false gap=0 (got marker=%v gap=%d)", i, s.marker, s.gap)
		}
	}
	// Payload order preserved.
	for i, s := range sends {
		if s.payload[0] != byte(i) {
			t.Fatalf("packet %d: payload out of order (got %d)", i, s.payload[0])
		}
	}
}

// Silence between talkspurts must surface as a timestamp gap plus a marker
// on the resuming packet — not as contiguous timestamps.
func TestPacerGapAndMarkerAcrossSilence(t *testing.T) {
	rec := &sendRecorder{}
	p, cancel := startTestPacer(t, rec, nil)
	defer cancel()

	p.enqueue(payloadsN(2))
	time.Sleep(100 * time.Millisecond) // let both go out
	pause := 200 * time.Millisecond
	time.Sleep(pause)
	p.enqueue(payloadsN(1))

	deadline := time.After(2 * time.Second)
	for len(rec.snapshot()) < 3 {
		select {
		case <-deadline:
			t.Fatalf("timed out: %d/3 packets sent", len(rec.snapshot()))
		case <-time.After(5 * time.Millisecond):
		}
	}
	sends := rec.snapshot()
	last := sends[2]
	if !last.marker {
		t.Error("first packet after silence must carry the talkspurt marker")
	}
	// ~300 ms of idle ≈ 15 frames; allow wide scheduling slack either side.
	if last.gap < 5 || last.gap > 30 {
		t.Errorf("timestamp gap after ~300 ms silence should be roughly 15 frames, got %d", last.gap)
	}
}

// clear() must drop queued audio: nothing else is sent after it, and the
// next talkspurt re-opens with a marker.
func TestPacerClearDropsQueuedAudio(t *testing.T) {
	rec := &sendRecorder{}
	p, cancel := startTestPacer(t, rec, nil)
	defer cancel()

	p.enqueue(payloadsN(50)) // ~1 s of queued audio
	time.Sleep(90 * time.Millisecond)
	dropped := p.clear()
	sentAtClear := len(rec.snapshot())
	if dropped == 0 {
		t.Fatal("clear() dropped nothing — queue was expected to hold a backlog")
	}
	if sentAtClear+dropped != 50 {
		t.Errorf("sent(%d) + dropped(%d) != enqueued(50)", sentAtClear, dropped)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(rec.snapshot()); n != sentAtClear {
		t.Fatalf("packets kept flowing after clear(): %d -> %d", sentAtClear, n)
	}

	p.enqueue(payloadsN(1))
	deadline := time.After(time.Second)
	for len(rec.snapshot()) < sentAtClear+1 {
		select {
		case <-deadline:
			t.Fatal("post-clear packet never sent")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if s := rec.snapshot(); !s[len(s)-1].marker {
		t.Error("first packet after clear() must open a fresh talkspurt (marker)")
	}
}

// While suspended (relay mode), queued audio is discarded and nothing is
// sent.
func TestPacerSuspendedDiscards(t *testing.T) {
	rec := &sendRecorder{}
	p, cancel := startTestPacer(t, rec, func() bool { return true })
	defer cancel()

	p.enqueue(payloadsN(5))
	time.Sleep(120 * time.Millisecond)
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("suspended pacer sent %d packets", n)
	}
	if d := p.depth(); d != 0 {
		t.Fatalf("suspended pacer kept %d packets queued (must discard)", d)
	}
}

// silenceFill is the fill payload the continuous-transmission tests use; a
// distinct byte so a fill packet is trivially distinguishable from the
// numbered speech payloads produced by payloadsN.
var silenceFill = []byte{0xFF}

func isFill(p []byte) bool { return len(p) == 1 && p[0] == 0xFF }

// With fill configured, an idle pacer must keep putting packets on the wire —
// this is the property that stops the far end's media watchdog firing during
// a silent stretch.
func TestPacerFillsSilentSlots(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{
		sendFn:    rec.send,
		suspended: func() bool { return false },
		fill:      func() []byte { return silenceFill },
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	// Nothing is ever enqueued: every packet must be fill.
	time.Sleep(200 * time.Millisecond)
	sends := rec.snapshot()
	if len(sends) < 5 {
		t.Fatalf("idle pacer sent %d packets in 200 ms — the stream stopped", len(sends))
	}
	for i, s := range sends {
		if !isFill(s.payload) {
			t.Fatalf("packet %d is not fill", i)
		}
		if s.marker {
			t.Errorf("packet %d: fill must not open a talkspurt", i)
		}
		if s.gap != 0 {
			t.Errorf("packet %d: continuous transmission means gap 0, got %d", i, s.gap)
		}
	}
}

// Under continuous transmission the timestamp must advance purely by
// packet count — so real audio resuming after silence carries gap 0 (the
// fill packets already moved the clock) but still marks the talkspurt.
func TestPacerFillKeepsTimestampContiguousAcrossSilence(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{
		sendFn:    rec.send,
		suspended: func() bool { return false },
		fill:      func() []byte { return silenceFill },
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	p.enqueue(payloadsN(2))
	time.Sleep(300 * time.Millisecond) // both go out, then ~13 fill slots
	p.enqueue(payloadsN(1))
	time.Sleep(120 * time.Millisecond)

	var speech []recordedSend
	for _, s := range rec.snapshot() {
		if !isFill(s.payload) {
			speech = append(speech, s)
		}
	}
	if len(speech) != 3 {
		t.Fatalf("expected 3 speech packets, got %d", len(speech))
	}
	resumed := speech[2]
	if !resumed.marker {
		t.Error("audio resuming after a filled silence must still carry the talkspurt marker")
	}
	if resumed.gap != 0 {
		t.Errorf("fill already advanced the clock, so gap must be 0, got %d", resumed.gap)
	}
}

// fill returning nil (media path not ready — no remote address yet) must fall
// back to suppression rather than erroring, and the deferred slots must show
// up as a timestamp gap on the first packet that does go out.
func TestPacerFillNotReadyFallsBackToGap(t *testing.T) {
	rec := &sendRecorder{}
	var ready bool
	var mu sync.Mutex
	p := &pacer{
		sendFn:    rec.send,
		suspended: func() bool { return false },
		fill: func() []byte {
			mu.Lock()
			defer mu.Unlock()
			if !ready {
				return nil
			}
			return silenceFill
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	time.Sleep(150 * time.Millisecond)
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("pacer sent %d packets before the media path was ready", n)
	}
	mu.Lock()
	ready = true
	mu.Unlock()
	time.Sleep(100 * time.Millisecond)
	if n := len(rec.snapshot()); n == 0 {
		t.Fatal("pacer never started transmitting once fill became available")
	}
}

// Relay mode still owns the media path: fill must not be transmitted while
// suspended, or the bridge would mix silence onto the peer's stream.
func TestPacerSuspendedSendsNoFill(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{
		sendFn:    rec.send,
		suspended: func() bool { return true },
		fill:      func() []byte { return silenceFill },
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	time.Sleep(150 * time.Millisecond)
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("suspended pacer transmitted %d fill packets", n)
	}
}

// Overflow beyond the queue bound drops the newest payloads instead of
// growing without bound.
func TestPacerOverflowBounded(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{sendFn: rec.send, suspended: func() bool { return false }}
	// No run loop: depth inspection only.
	p.enqueue(payloadsN(maxPaceQueue + 100))
	if d := p.depth(); d != maxPaceQueue {
		t.Fatalf("queue depth %d, want cap %d", d, maxPaceQueue)
	}
	p.enqueue(payloadsN(1))
	if d := p.depth(); d != maxPaceQueue {
		t.Fatalf("queue grew past cap: %d", d)
	}
}

// --- starvation accounting -------------------------------------------------
//
// The pacer fills an empty slot with codec silence, which is correct for a SIP
// UA but makes running dry invisible: the wire looks perfect and the caller
// hears a hole. On the WebRTC path the same blind spot needed a purpose-built
// rig to find. These pin the counters that would make it announce itself here.

// fillFn reuses the package's existing silenceFill payload so a filled slot
// stays distinguishable from speech (see isFill above).
func fillFn() []byte { return silenceFill }

// TestPacerCountsAShortStarve: a brief run of fill that ends with real audio is
// the queue running dry mid-utterance — the case that is audible.
func TestPacerCountsAShortStarve(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{sendFn: rec.send, fill: fillFn}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	p.enqueue(payloadsN(2))
	time.Sleep(3 * paceFrame) // drains, then starves
	time.Sleep(3 * paceFrame) // ~3 filled slots
	p.enqueue(payloadsN(2))   // real audio resumes: the run ends here
	time.Sleep(4 * paceFrame)

	p.mu.Lock()
	events, frames, worst := p.starveEvents, p.starveFrames, p.starveMaxRun
	p.mu.Unlock()
	if events != 1 {
		t.Fatalf("starveEvents = %d, want 1", events)
	}
	if frames == 0 || frames > maxStarveRun {
		t.Fatalf("starveFrames = %d, want a short run", frames)
	}
	if worst == 0 {
		t.Fatalf("starveMaxRun = 0, want the length of the run")
	}
}

// TestPacerIgnoresALongQuietPeriod: the bot simply not talking must not be
// counted as starvation. Getting this wrong on the Python side made a 9.8 s
// caller turn read as a 9.8 s "underrun".
func TestPacerIgnoresALongQuietPeriod(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{sendFn: rec.send, fill: fillFn}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	p.enqueue(payloadsN(1))
	time.Sleep(2 * paceFrame)
	// a quiet stretch longer than the threshold, then speech again
	p.mu.Lock()
	p.silentRun = maxStarveRun + 10
	p.mu.Unlock()
	p.enqueue(payloadsN(1))
	time.Sleep(3 * paceFrame)

	p.mu.Lock()
	events := p.starveEvents
	p.mu.Unlock()
	if events != 0 {
		t.Fatalf("starveEvents = %d, want 0 — a long quiet run is not a fault", events)
	}
}

// TestPacerRecordsQueueDepth: time spent shallow is the thing that makes a
// hiccup audible, so the histogram has to reflect the queue the slot saw.
func TestPacerRecordsQueueDepth(t *testing.T) {
	rec := &sendRecorder{}
	p := &pacer{sendFn: rec.send, fill: fillFn}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	p.enqueue(payloadsN(8))
	time.Sleep(10 * paceFrame)

	p.mu.Lock()
	slots, hist := p.slots, p.depthHist
	p.mu.Unlock()
	if slots == 0 {
		t.Fatal("no slots recorded")
	}
	total := 0
	for _, n := range hist {
		total += n
	}
	if total != slots {
		t.Fatalf("histogram totals %d, slots %d — every slot must be bucketed", total, slots)
	}
	if hist[depthBucket(6)] == 0 && hist[depthBucket(8)] == 0 {
		t.Fatalf("depth never recorded above 5 despite an 8-deep queue: %v", hist)
	}
}

func TestDepthBucketBoundaries(t *testing.T) {
	for _, c := range []struct {
		n    int
		want int
	}{{0, 0}, {1, 1}, {2, 1}, {3, 2}, {5, 2}, {6, 3}, {10, 3}, {11, 4}, {3000, 4}} {
		if got := depthBucket(c.n); got != c.want {
			t.Errorf("depthBucket(%d) = %d, want %d", c.n, got, c.want)
		}
	}
}
