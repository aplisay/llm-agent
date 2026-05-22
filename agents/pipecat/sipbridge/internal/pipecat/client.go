package pipecat

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog/log"
)

// Client is a per-call WebSocket client speaking the Pipecat protobuf
// frame protocol. The worker side uses
// `pipecat.transports.websocket.fastapi.FastAPIWebsocketTransport` with
// `pipecat.serializers.protobuf.ProtobufFrameSerializer` — see
// `agents/pipecat/pipecat_aplisay/worker.py:voiceblender_agent` for the
// equivalent connection on the other end. We are the WS client; the
// worker is the WS server.
//
// Audio direction:
//   - SendAudio: PCM16 s16le bytes at 16 kHz mono, framed as
//     AudioRawFrame and sent as a single binary WS message.
//   - OnAudio callback: invoked with PCM16 s16le bytes at 16 kHz mono
//     received from the worker (Pipecat TTS output, the bot voice).
//
// The client owns the WS connection lifetime; close it via Stop() which
// cancels the read loop and closes the socket. The read loop also exits
// (and the call manager's audio bridge tears down) on any read error.
type Client struct {
	url string

	conn *websocket.Conn
	mu   sync.Mutex // protects Write — concurrent writes on a single
	// WebSocket are unsafe.

	onAudio   func(samplesS16LE []byte)
	onText    func(TextFrame)
	onTscript func(TranscriptionFrame)
	onClose   func(err error)

	cancel  context.CancelFunc
	done    chan struct{}
	stopped bool

	// audioRateWarned ensures the unexpected-sample-rate warning fires
	// at most once per Client (rather than once per audio frame, which
	// would be many times a second).
	audioRateWarned bool

	// closeErr is the read-loop's terminating error, set just before
	// ``done`` is closed. Read it via ``CloseErr()`` after ``Done()`` has
	// fired (or after ``WaitForEarlyClose`` returns true). The bridge
	// uses this to recover the WS close code from a worker that rejected
	// the call by closing immediately after accept (the fallback path
	// for ``_ws_deny`` when ASGI denial response isn't available — see
	// ``pipecat_aplisay/worker.py``).
	closeErr error
}

// NewClient prepares (but does not yet connect) a client. Call Connect
// to open the WS.
func NewClient(url string) *Client {
	return &Client{
		url:  url,
		done: make(chan struct{}),
	}
}

// SetAudioHandler registers the callback for inbound audio frames.
// Must be set before Connect() — the read loop starts immediately.
func (c *Client) SetAudioHandler(fn func(samplesS16LE []byte)) {
	c.onAudio = fn
}

// SetTextHandler registers an optional callback for TextFrame events
// (LLM-side sentence streaming).
func (c *Client) SetTextHandler(fn func(TextFrame)) {
	c.onText = fn
}

// SetTranscriptionHandler registers an optional callback for STT output.
func (c *Client) SetTranscriptionHandler(fn func(TranscriptionFrame)) {
	c.onTscript = fn
}

// SetCloseHandler registers a callback fired exactly once when the
// connection terminates (cleanly or otherwise). The bridge uses this to
// tear down the matching RTP session and SIP dialog.
func (c *Client) SetCloseHandler(fn func(err error)) {
	c.onClose = fn
}

// DialError is returned by Connect when the WS upgrade fails. It carries
// the HTTP status code from the worker's denial response when the worker
// rejected the upgrade (e.g. 404 if no agent is configured for the
// dialled number, 503 if the worker can't reach its REST control plane).
// HTTPStatus is 0 when the failure was at the transport layer (TCP
// refused, DNS, TLS, …) — i.e. we never got an HTTP response.
//
// Calling code uses HTTPStatus to map worker failures to meaningful SIP
// response codes; see internal/call/manager.go onInvite.
type DialError struct {
	URL        string
	HTTPStatus int
	Wrapped    error
}

func (e *DialError) Error() string {
	if e.HTTPStatus != 0 {
		return fmt.Sprintf("pipecat ws dial %q: server denied with HTTP %d: %v",
			e.URL, e.HTTPStatus, e.Wrapped)
	}
	return fmt.Sprintf("pipecat ws dial %q: %v", e.URL, e.Wrapped)
}

func (e *DialError) Unwrap() error { return e.Wrapped }

// captureTransport is a minimal http.RoundTripper that records the last
// response it saw. We inject it into coder/websocket's DialOptions so
// that — when the worker denies the upgrade with a non-101 response —
// we can read the HTTP status code (which the public ``websocket.Dial``
// otherwise discards on error). On success the captured response is
// just the 101 Switching Protocols, which we ignore.
type captureTransport struct {
	base     http.RoundTripper
	lastResp *http.Response
}

func (t *captureTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	t.lastResp = resp
	return resp, err
}

// Connect dials the worker's WS endpoint and spawns the read loop.
// Returns immediately on successful handshake; failures are reported as
// a *DialError here (carrying the HTTP status when the worker denied
// the upgrade) and via SetCloseHandler if they occur mid-stream.
func (c *Client) Connect(ctx context.Context, hdr http.Header) error {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ct := &captureTransport{base: http.DefaultTransport}
	conn, _, err := websocket.Dial(dctx, c.url, &websocket.DialOptions{
		HTTPHeader: hdr,
		// Wrap the default HTTPClient so we can recover the HTTP status
		// from a denial response — see captureTransport above.
		HTTPClient: &http.Client{Transport: ct},
	})
	if err != nil {
		status := 0
		if ct.lastResp != nil {
			status = ct.lastResp.StatusCode
		}
		return &DialError{URL: c.url, HTTPStatus: status, Wrapped: err}
	}
	// `MessageBinary` audio frames can be large (20 ms of 16 kHz s16le
	// mono is 640 bytes; an LLM may chunk larger). Lift the read limit
	// so we don't truncate.
	conn.SetReadLimit(1 << 20) // 1 MiB
	c.conn = conn

	rctx, rcancel := context.WithCancel(context.Background())
	c.cancel = rcancel
	go c.readLoop(rctx)
	log.Info().Str("url", c.url).Msg("pipecat ws connected")
	return nil
}

// SendAudio frames a single AudioRawFrame and sends it as one binary
// message. PCM16 little-endian, 16 kHz, mono — matches what
// `WebsocketServerTransport` expects from the wire when it does its own
// internal resampling/feeding into the pipeline.
func (c *Client) SendAudio(pcm16 []byte) error {
	if c.conn == nil {
		return errors.New("pipecat client: not connected")
	}
	frame := EncodeAudio(AudioRawFrame{
		Audio:      pcm16,
		SampleRate: 16000,
		NumChans:   1,
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	wctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.conn.Write(wctx, websocket.MessageBinary, frame)
}

// SendMessage frames a MessageFrame and sends it. The body is a
// free-form string (the platform's convention is to use small JSON
// blobs there — see internal/call/manager.go:handleDTMF for the
// canonical DTMF event shape).
//
// MessageFrame travels on the same WebSocket as audio; Pipecat's
// ProtobufFrameSerializer dispatches it to the receiving end as a
// MessageFrame frame which can be routed through the pipeline like
// any other.
func (c *Client) SendMessage(data string) error {
	if c.conn == nil {
		return errors.New("pipecat client: not connected")
	}
	frame := EncodeMessage(data)
	c.mu.Lock()
	defer c.mu.Unlock()
	wctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.conn.Write(wctx, websocket.MessageBinary, frame)
}

// Stop closes the WebSocket cleanly. Safe to call multiple times.
func (c *Client) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	c.mu.Unlock()
	if c.cancel != nil {
		c.cancel()
	}
	if c.conn != nil {
		_ = c.conn.Close(websocket.StatusNormalClosure, "sipbridge: call ended")
	}
}

// Done reports a channel that closes when the read loop has exited.
// Use this to coordinate teardown.
func (c *Client) Done() <-chan struct{} {
	return c.done
}

// CloseErr returns the error that ended the read loop (or nil if the
// loop hasn't ended yet). Safe to call after Done() has fired or after
// WaitForEarlyClose returned true. For a worker-initiated rejection
// this is a ``*websocket.CloseError`` and the close code is recoverable
// via ``websocket.CloseStatus(err)``.
func (c *Client) CloseErr() error {
	return c.closeErr
}

// WaitForEarlyClose blocks up to ``timeout`` waiting for the WS to
// close. Returns true if a close happened in that window (in which case
// CloseErr() is set), false if the timeout elapsed and the call is
// still live.
//
// Used by the call manager right after Connect succeeds: a worker that
// can't honour the call (e.g. no agent for the dialled number) but
// can't / won't use the ASGI denial-response extension accepts the WS
// upgrade and then closes immediately with a private-use WS close code
// (4xxx) encoding the SIP rejection status. The manager waits a short
// window for this so a clean SIP-rejection response can replace the
// otherwise-inevitable 200 OK.
func (c *Client) WaitForEarlyClose(timeout time.Duration) bool {
	select {
	case <-c.done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (c *Client) readLoop(ctx context.Context) {
	defer close(c.done)
	defer func() {
		if c.onClose != nil {
			c.onClose(c.closeErr)
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		mt, data, err := c.conn.Read(ctx)
		if err != nil {
			c.closeErr = err
			if !errors.Is(err, context.Canceled) {
				log.Warn().Err(err).Str("url", c.url).Msg("pipecat ws read ended")
			}
			return
		}
		if mt != websocket.MessageBinary {
			// Pipecat sends everything as binary protobuf; text messages
			// would be a protocol violation, so drop them with a log.
			log.Warn().Int("type", int(mt)).Msg("pipecat ws: dropping non-binary message")
			continue
		}
		frame, err := DecodeFrame(data)
		if err != nil {
			log.Warn().Err(err).Int("len", len(data)).Msg("pipecat ws: malformed frame")
			continue
		}
		c.dispatch(frame)
	}
}

func (c *Client) dispatch(frame *IncomingFrame) {
	switch {
	case frame.Audio != nil:
		// Worker is expected to emit AudioRawFrame at 16 kHz mono
		// s16le, matching what FastAPIWebsocketParams pins it to (see
		// pipecat_aplisay/worker.py). If we see a different sample rate
		// the bridge's downsampler will mis-interpret the samples and
		// the caller hears chipmunked / aliased audio — log loudly so
		// it's obvious from the bridge logs which side is misconfigured.
		// We log at most once per call.
		if frame.Audio.SampleRate != 0 && frame.Audio.SampleRate != 16000 && !c.audioRateWarned {
			c.audioRateWarned = true
			log.Warn().
				Uint32("got", frame.Audio.SampleRate).
				Uint32("expected", 16000).
				Str("url", c.url).
				Msg("pipecat ws: unexpected audio sample rate — fix audio_in/out_sample_rate in worker FastAPIWebsocketParams or the audio will be distorted on the SIP wire")
		}
		if c.onAudio != nil {
			c.onAudio(frame.Audio.Audio)
		}
	case frame.Text != nil:
		if c.onText != nil {
			c.onText(*frame.Text)
		}
	case frame.Transcription != nil:
		if c.onTscript != nil {
			c.onTscript(*frame.Transcription)
		}
	case frame.Message != nil:
		// Unused on this path — Pipecat application messages travel via
		// a different channel in our worker. Log at debug.
		log.Debug().Str("data", frame.Message.Data).Msg("pipecat ws: message frame ignored")
	}
}
