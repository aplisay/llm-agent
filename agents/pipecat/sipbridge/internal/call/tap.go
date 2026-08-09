package call

// Bridged-transfer transcription tap (options.bridgedTransferTranscribe).
//
// When a bridged transfer is installed with ``tap_audio: true``, the two
// humans' RTP keeps flowing through the in-process relay untouched (the
// fast path gains no latency and no dependency on the worker), but a COPY
// of each leg's decoded audio is pushed into a tapMixer, which emits one
// interleaved stereo PCM frame every 20 ms on the monitoring leg's
// kept-open worker WS:
//
//	left channel  = the original caller leg
//	right channel = the transfer-target leg
//
// The worker splits the channels and runs speech-to-text per side to
// build a speaker-labelled transcript of the human↔human segment — see
// pipecat_aplisay/bridged_transfer.py and docs/call-transfers.md.
//
// The tap is deliberately lossy in both directions: a slow or dead WS
// never back-pressures the bridge (SendAudioStereo runs on the mixer
// goroutine, and per-side backlogs are capped), and silence is
// substituted for a side that has no pending samples so the two channels
// stay time-aligned enough for transcription.

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/codec"
	pcclient "github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/pipecat"
	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/rtp"
)

const (
	tapChunkSamples = 320   // 20 ms at 16 kHz, per channel
	tapMaxBacklog   = 16000 // 1 s per side; older samples are dropped
	tapSideCaller   = 0
	tapSideTarget   = 1
)

type tapMixer struct {
	mu      sync.Mutex
	pending [2][]int16 // per-side queued 16 kHz mono samples
	ws      *pcclient.Client
	cancel  context.CancelFunc
	stopped bool
}

// newTapMixer starts the 20 ms emit loop. ``ws`` is the monitoring leg's
// kept-open worker client.
func newTapMixer(ws *pcclient.Client) *tapMixer {
	ctx, cancel := context.WithCancel(context.Background())
	t := &tapMixer{ws: ws, cancel: cancel}
	go t.run(ctx)
	return t
}

// push queues decoded 16 kHz samples for one side of the bridge. Called
// from the RTP read loops; must stay cheap.
func (t *tapMixer) push(side int, samples []int16) {
	if side != tapSideCaller && side != tapSideTarget {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return
	}
	t.pending[side] = append(t.pending[side], samples...)
	if overflow := len(t.pending[side]) - tapMaxBacklog; overflow > 0 {
		t.pending[side] = t.pending[side][overflow:]
	}
}

// Stop halts the emit loop. Idempotent; safe from any goroutine.
func (t *tapMixer) Stop() {
	t.mu.Lock()
	already := t.stopped
	t.stopped = true
	t.mu.Unlock()
	if !already && t.cancel != nil {
		t.cancel()
	}
}

func (t *tapMixer) run(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	frame := make([]byte, tapChunkSamples*2*2) // stereo s16le
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		t.mu.Lock()
		if t.stopped {
			t.mu.Unlock()
			return
		}
		// Skip the frame entirely while BOTH sides are silent — no point
		// streaming continuous silence at the worker's STT.
		if len(t.pending[tapSideCaller]) == 0 && len(t.pending[tapSideTarget]) == 0 {
			t.mu.Unlock()
			continue
		}
		var sides [2][]int16
		for side := range t.pending {
			n := len(t.pending[side])
			if n >= tapChunkSamples {
				sides[side] = t.pending[side][:tapChunkSamples]
				t.pending[side] = t.pending[side][tapChunkSamples:]
			} else {
				// Whatever is queued, padded with silence.
				chunk := make([]int16, tapChunkSamples)
				copy(chunk, t.pending[side])
				t.pending[side] = t.pending[side][:0]
				sides[side] = chunk
			}
		}
		t.mu.Unlock()
		for i := 0; i < tapChunkSamples; i++ {
			l := sides[tapSideCaller][i]
			r := sides[tapSideTarget][i]
			frame[i*4] = byte(l)
			frame[i*4+1] = byte(uint16(l) >> 8)
			frame[i*4+2] = byte(r)
			frame[i*4+3] = byte(uint16(r) >> 8)
		}
		if err := t.ws.SendAudioStereo(frame); err != nil {
			// Worker gone (or unbridge in flight) — the tap is best-effort;
			// stop rather than spam errors every 20 ms.
			log.Debug().Err(err).Msg("call: transcription tap send failed; stopping tap")
			t.Stop()
			return
		}
	}
}

// decode16k converts one G.711 RTP payload from this call's negotiated
// codec into 16 kHz mono samples (same codec path as the bot-mode
// processDecodedPayload). Returns nil for unknown payload types.
func (c *Call) decode16k(payload []byte) []int16 {
	var samples8k []int16
	switch c.payload {
	case rtp.PayloadPCMU:
		samples8k = codec.DecodePCMU(payload)
	case rtp.PayloadPCMA:
		samples8k = codec.DecodePCMA(payload)
	default:
		return nil
	}
	return codec.Upsample8To16(samples8k)
}
