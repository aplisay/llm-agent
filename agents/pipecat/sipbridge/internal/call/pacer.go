package call

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// pacer smooths the worker→caller audio path onto a real-time RTP cadence.
//
// Why it exists: Pipecat's websocket output transport deliberately sends
// audio at up to 2× real-time when it has a backlog (its send interval is
// half the chunk duration — a buffer-priming strategy for browser clients).
// The bridge used to forward each WS chunk to RTP the moment it arrived, so
// during any long utterance the wire carried ~20 ms of audio every ~10 ms.
// A carrier-side jitter buffer plays at 1×, overflows within a few hundred
// milliseconds, and discards the rest — heard as garbled/chopped speech at
// the handset while the worker-side recording (tapped before the WS) stays
// perfect. The pacer restores the invariant the PSTN expects: one 20 ms
// packet every 20 ms, timestamps that track the wall clock across silence,
// and a marker bit on each talkspurt start (RFC 3550 §5.1).
//
// Shape: onWSAudio enqueues encoded 20 ms G.711 payloads; a single goroutine
// (run) pops one payload per 20 ms frame slot and hands it to sendFn together
// with the accumulated silence gap (in frames) and the talkspurt marker.
// Empty slots while a stream is live count toward the next packet's timestamp
// jump, so playout timing survives bot pauses without sending silence
// packets. clear() drops queued-but-unsent audio (barge-in — the worker has
// already shipped the rest of the utterance at 2×, and it must not play over
// the caller).
type pacer struct {
	// sendFn writes one payload to the wire. gapFrames is how many whole
	// 20 ms frames of silence preceded this packet (0 = contiguous speech);
	// marker flags a talkspurt start.
	sendFn func(payload []byte, gapFrames uint32, marker bool) error
	// suspended reports whether sending must be withheld (relay mode owns
	// the media path). Queued audio is discarded while suspended.
	suspended func() bool
	// onSendError is invoked once if sendFn fails; the run loop exits after.
	onSendError func(err error)

	mu      sync.Mutex
	queue   [][]byte
	idle    uint32 // empty frame slots since the last send (pending ts jump)
	started bool   // at least one packet sent (first ever packet gets marker)
	dropped int    // payloads discarded by overflow/clear/suspend since last log
}

const (
	// paceFrame is the RTP packetisation interval: 160 samples at 8 kHz.
	paceFrame = 20 * time.Millisecond
	// maxPaceLag bounds the catch-up burst after a scheduler stall: if the
	// loop falls further behind than this it re-anchors to the wall clock
	// and accounts the skipped slots as silence instead of bursting them.
	maxPaceLag = 200 * time.Millisecond
	// maxPaceQueue bounds queue growth (60 s of audio). At the design 2×
	// ingress rate the depth peaks at half the utterance length, so this
	// only trips on runaway input; overflow drops the newest audio.
	maxPaceQueue = 3000
)

// enqueue appends encoded payloads for paced sending. Payloads beyond the
// queue bound are dropped (newest-first) with a rate-limited warning.
func (p *pacer) enqueue(payloads [][]byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	room := maxPaceQueue - len(p.queue)
	if room <= 0 {
		p.dropped += len(payloads)
		p.warnDroppedLocked("overflow")
		return
	}
	if len(payloads) > room {
		p.dropped += len(payloads) - room
		payloads = payloads[:room]
		p.warnDroppedLocked("overflow")
	}
	p.queue = append(p.queue, payloads...)
}

// clear drops all queued-but-unsent audio (barge-in / relay engage) and
// returns how many packets were discarded. The pacing clock keeps running,
// so the next enqueued audio starts a fresh talkspurt with a wall-clock-
// correct timestamp jump.
func (p *pacer) clear() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := len(p.queue)
	p.queue = nil
	return n
}

// depth reports the current queue depth (packets).
func (p *pacer) depth() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.queue)
}

func (p *pacer) warnDroppedLocked(reason string) {
	// Rate-limit: log every 250 drops (~5 s of audio) rather than per packet.
	if p.dropped == 1 || p.dropped%250 == 0 {
		log.Warn().Int("dropped", p.dropped).Str("reason", reason).
			Msg("pacer: dropping bot audio")
	}
}

// run is the pacing loop. One frame slot per paceFrame: a queued payload is
// sent with the pending gap/marker state; an empty slot just extends the gap.
// After a scheduler stall the loop sends back-to-back until it has caught up
// with the wall clock (bounded by maxPaceLag, past which it re-anchors and
// converts the lost slots into silence gap).
func (p *pacer) run(ctx context.Context) {
	next := time.Now()
	for {
		d := time.Until(next)
		if d > 0 {
			t := time.NewTimer(d)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
		} else {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if -d > maxPaceLag {
				skipped := uint32(-d / paceFrame)
				p.mu.Lock()
				if p.started {
					p.idle += skipped
				}
				p.mu.Unlock()
				next = time.Now()
			}
		}

		if p.suspended != nil && p.suspended() {
			// Relay mode owns the media path; stale bot audio must not be
			// mixed onto the caller's RTP stream.
			p.mu.Lock()
			if n := len(p.queue); n > 0 {
				p.dropped += n
				p.queue = nil
				p.warnDroppedLocked("suspended")
			}
			if p.started {
				p.idle++
			}
			p.mu.Unlock()
			next = next.Add(paceFrame)
			continue
		}

		p.mu.Lock()
		var payload []byte
		if len(p.queue) > 0 {
			payload = p.queue[0]
			p.queue = p.queue[1:]
		}
		if payload == nil {
			if p.started {
				p.idle++
			}
			p.mu.Unlock()
			next = next.Add(paceFrame)
			continue
		}
		gap := p.idle
		marker := !p.started || gap > 0
		p.idle = 0
		p.started = true
		p.mu.Unlock()

		if err := p.sendFn(payload, gap, marker); err != nil {
			if p.onSendError != nil {
				p.onSendError(err)
			}
			return
		}
		next = next.Add(paceFrame)
	}
}
