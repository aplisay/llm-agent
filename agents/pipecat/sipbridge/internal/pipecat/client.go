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

// Connect dials the worker's WS endpoint and spawns the read loop.
// Returns immediately on successful handshake; failures are reported as
// an error here and via SetCloseHandler if they occur mid-stream.
func (c *Client) Connect(ctx context.Context, hdr http.Header) error {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dctx, c.url, &websocket.DialOptions{
		HTTPHeader: hdr,
	})
	if err != nil {
		return fmt.Errorf("pipecat ws dial %q: %w", c.url, err)
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

func (c *Client) readLoop(ctx context.Context) {
	defer close(c.done)
	var closeErr error
	defer func() {
		if c.onClose != nil {
			c.onClose(closeErr)
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
			closeErr = err
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
		// Worker emits AudioRawFrame at 16 kHz mono s16le per its
		// `WebsocketServerTransport` audio-out config. Pass through to
		// the registered handler; the RTP layer downsamples + encodes
		// for the wire.
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
