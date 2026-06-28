// Package pipecat implements the Pipecat WebSocket transport protocol on
// the client side.
//
// The wire format is Google Protocol Buffers, schema in
// `proto/frames.proto`. The Python side uses
// `pipecat.serializers.protobuf.ProtobufFrameSerializer`; we re-implement
// the wire codec by hand here so the bridge has no protoc / codegen build
// dependency. The protobuf wire format is small and well-defined — see
// https://protobuf.dev/programming-guides/encoding/ — and the Pipecat
// frame messages we care about have no maps, no nested submessages
// beyond the outer Frame `oneof`, and no enums. Hand-rolling the encoder
// is cheaper than wiring protoc into the Dockerfile.
//
// If Pipecat adds a new field to `frames.proto`, mirror the change here
// (the upstream schema is mirrored in `proto/frames.proto` for ease of
// diffing).
package pipecat

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Wire types we use. Pipecat frames only need varint (0) and
// length-delimited (2).
const (
	wireVarint = 0
	wireLen    = 2
)

// AudioRawFrame field tags (from frames.proto).
const (
	audioTagID         = 1 // uint64
	audioTagName       = 2 // string
	audioTagAudio      = 3 // bytes
	audioTagSampleRate = 4 // uint32
	audioTagNumChans   = 5 // uint32
	audioTagPTS        = 6 // optional uint64
)

// TextFrame, TranscriptionFrame, MessageFrame field tags.
const (
	textTagID   = 1
	textTagName = 2
	textTagText = 3

	transcriptionTagID        = 1
	transcriptionTagName      = 2
	transcriptionTagText      = 3
	transcriptionTagUserID    = 4
	transcriptionTagTimestamp = 5

	messageTagData = 1
)

// Outer Frame oneof tags.
const (
	frameTagText          = 1
	frameTagAudio         = 2
	frameTagTranscription = 3
	frameTagMessage       = 4
)

// AudioRawFrame is the Go equivalent of pipecat.AudioRawFrame.
//
// PTS uses a pointer to model the proto3 `optional` field — nil means
// "not set" and the bridge omits it on the wire, matching how
// ProtobufFrameSerializer treats AudioRawFrame.pts.
type AudioRawFrame struct {
	ID         uint64
	Name       string
	Audio      []byte
	SampleRate uint32
	NumChans   uint32
	PTS        *uint64
}

// TextFrame mirrors pipecat.TextFrame — emitted by the LLM at sentence
// boundaries when text streaming is enabled.
type TextFrame struct {
	ID   uint64
	Name string
	Text string
}

// TranscriptionFrame mirrors pipecat.TranscriptionFrame — STT output.
type TranscriptionFrame struct {
	ID        uint64
	Name      string
	Text      string
	UserID    string
	Timestamp string
}

// MessageFrame mirrors pipecat.MessageFrame — application-level JSON
// passthrough.
type MessageFrame struct {
	Data string
}

// IncomingFrame is what DecodeFrame produces — exactly one of its
// pointer fields is non-nil, matching the proto3 oneof semantics.
type IncomingFrame struct {
	Audio         *AudioRawFrame
	Text          *TextFrame
	Transcription *TranscriptionFrame
	Message       *MessageFrame
}

// EncodeAudio returns the bytes of a wire `Frame{audio: AudioRawFrame{...}}`.
//
// The outer Frame oneof wraps the AudioRawFrame in a length-delimited
// field at tag 2 (audio). Wire format reminder:
//
//	tag = (field_number << 3) | wire_type
//
// For a length-delimited submessage we emit `<tag-varint> <len-varint>
// <submessage-bytes>`.
func EncodeAudio(f AudioRawFrame) []byte {
	inner := encodeAudioInner(f)
	out := make([]byte, 0, len(inner)+8)
	out = appendTag(out, frameTagAudio, wireLen)
	out = appendVarint(out, uint64(len(inner)))
	out = append(out, inner...)
	return out
}

// EncodeMessage builds a `Frame{message: MessageFrame{data: ...}}`. Used
// for application-level metadata channel (rare on this bridge but kept
// for completeness).
func EncodeMessage(data string) []byte {
	inner := encodeMessageInner(MessageFrame{Data: data})
	out := make([]byte, 0, len(inner)+8)
	out = appendTag(out, frameTagMessage, wireLen)
	out = appendVarint(out, uint64(len(inner)))
	out = append(out, inner...)
	return out
}

// DecodeFrame parses one wire-encoded `Frame` message and returns the
// populated oneof branch. Unknown fields are skipped (per protobuf
// forward-compat conventions).
func DecodeFrame(b []byte) (*IncomingFrame, error) {
	out := &IncomingFrame{}
	for len(b) > 0 {
		tag, wire, n, err := decodeTag(b)
		if err != nil {
			return nil, err
		}
		b = b[n:]
		if wire != wireLen {
			// All four Frame oneof branches are length-delimited; any
			// other wire type at the outer level is malformed or a
			// future addition we don't understand. Skip safely.
			if err := skipWire(&b, wire); err != nil {
				return nil, err
			}
			continue
		}
		length, n, err := decodeVarint(b)
		if err != nil {
			return nil, err
		}
		b = b[n:]
		if uint64(len(b)) < length {
			return nil, errors.New("frame: length-delimited field overruns buffer")
		}
		payload := b[:length]
		b = b[length:]
		switch tag {
		case frameTagAudio:
			a, err := decodeAudioInner(payload)
			if err != nil {
				return nil, fmt.Errorf("audio: %w", err)
			}
			out.Audio = a
		case frameTagText:
			t, err := decodeTextInner(payload)
			if err != nil {
				return nil, fmt.Errorf("text: %w", err)
			}
			out.Text = t
		case frameTagTranscription:
			t, err := decodeTranscriptionInner(payload)
			if err != nil {
				return nil, fmt.Errorf("transcription: %w", err)
			}
			out.Transcription = t
		case frameTagMessage:
			m, err := decodeMessageInner(payload)
			if err != nil {
				return nil, fmt.Errorf("message: %w", err)
			}
			out.Message = m
		default:
			// Forward-compatible: ignore unknown oneof branches.
		}
	}
	return out, nil
}

// ---- inner encoders ----

func encodeAudioInner(f AudioRawFrame) []byte {
	// Estimated capacity: header bytes + audio payload + small slack.
	out := make([]byte, 0, len(f.Audio)+64)
	if f.ID != 0 {
		out = appendTag(out, audioTagID, wireVarint)
		out = appendVarint(out, f.ID)
	}
	if f.Name != "" {
		out = appendTag(out, audioTagName, wireLen)
		out = appendVarint(out, uint64(len(f.Name)))
		out = append(out, f.Name...)
	}
	if len(f.Audio) > 0 {
		out = appendTag(out, audioTagAudio, wireLen)
		out = appendVarint(out, uint64(len(f.Audio)))
		out = append(out, f.Audio...)
	}
	if f.SampleRate != 0 {
		out = appendTag(out, audioTagSampleRate, wireVarint)
		out = appendVarint(out, uint64(f.SampleRate))
	}
	if f.NumChans != 0 {
		out = appendTag(out, audioTagNumChans, wireVarint)
		out = appendVarint(out, uint64(f.NumChans))
	}
	if f.PTS != nil {
		out = appendTag(out, audioTagPTS, wireVarint)
		out = appendVarint(out, *f.PTS)
	}
	return out
}

func encodeMessageInner(m MessageFrame) []byte {
	out := make([]byte, 0, len(m.Data)+8)
	if m.Data != "" {
		out = appendTag(out, messageTagData, wireLen)
		out = appendVarint(out, uint64(len(m.Data)))
		out = append(out, m.Data...)
	}
	return out
}

// ---- inner decoders ----

func decodeAudioInner(b []byte) (*AudioRawFrame, error) {
	f := &AudioRawFrame{}
	for len(b) > 0 {
		tag, wire, n, err := decodeTag(b)
		if err != nil {
			return nil, err
		}
		b = b[n:]
		switch {
		case tag == audioTagID && wire == wireVarint:
			v, n, err := decodeVarint(b)
			if err != nil {
				return nil, err
			}
			f.ID = v
			b = b[n:]
		case tag == audioTagName && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Name = s
			b = b[n:]
		case tag == audioTagAudio && wire == wireLen:
			by, n, err := decodeBytes(b)
			if err != nil {
				return nil, err
			}
			f.Audio = by
			b = b[n:]
		case tag == audioTagSampleRate && wire == wireVarint:
			v, n, err := decodeVarint(b)
			if err != nil {
				return nil, err
			}
			f.SampleRate = uint32(v)
			b = b[n:]
		case tag == audioTagNumChans && wire == wireVarint:
			v, n, err := decodeVarint(b)
			if err != nil {
				return nil, err
			}
			f.NumChans = uint32(v)
			b = b[n:]
		case tag == audioTagPTS && wire == wireVarint:
			v, n, err := decodeVarint(b)
			if err != nil {
				return nil, err
			}
			pts := v
			f.PTS = &pts
			b = b[n:]
		default:
			if err := skipWire(&b, wire); err != nil {
				return nil, err
			}
		}
	}
	return f, nil
}

func decodeTextInner(b []byte) (*TextFrame, error) {
	f := &TextFrame{}
	for len(b) > 0 {
		tag, wire, n, err := decodeTag(b)
		if err != nil {
			return nil, err
		}
		b = b[n:]
		switch {
		case tag == textTagID && wire == wireVarint:
			v, n, err := decodeVarint(b)
			if err != nil {
				return nil, err
			}
			f.ID = v
			b = b[n:]
		case tag == textTagName && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Name = s
			b = b[n:]
		case tag == textTagText && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Text = s
			b = b[n:]
		default:
			if err := skipWire(&b, wire); err != nil {
				return nil, err
			}
		}
	}
	return f, nil
}

func decodeTranscriptionInner(b []byte) (*TranscriptionFrame, error) {
	f := &TranscriptionFrame{}
	for len(b) > 0 {
		tag, wire, n, err := decodeTag(b)
		if err != nil {
			return nil, err
		}
		b = b[n:]
		switch {
		case tag == transcriptionTagID && wire == wireVarint:
			v, n, err := decodeVarint(b)
			if err != nil {
				return nil, err
			}
			f.ID = v
			b = b[n:]
		case tag == transcriptionTagName && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Name = s
			b = b[n:]
		case tag == transcriptionTagText && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Text = s
			b = b[n:]
		case tag == transcriptionTagUserID && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.UserID = s
			b = b[n:]
		case tag == transcriptionTagTimestamp && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Timestamp = s
			b = b[n:]
		default:
			if err := skipWire(&b, wire); err != nil {
				return nil, err
			}
		}
	}
	return f, nil
}

func decodeMessageInner(b []byte) (*MessageFrame, error) {
	f := &MessageFrame{}
	for len(b) > 0 {
		tag, wire, n, err := decodeTag(b)
		if err != nil {
			return nil, err
		}
		b = b[n:]
		switch {
		case tag == messageTagData && wire == wireLen:
			s, n, err := decodeString(b)
			if err != nil {
				return nil, err
			}
			f.Data = s
			b = b[n:]
		default:
			if err := skipWire(&b, wire); err != nil {
				return nil, err
			}
		}
	}
	return f, nil
}

// ---- low-level wire helpers ----

func appendTag(b []byte, field int, wire int) []byte {
	return appendVarint(b, uint64(field<<3|wire))
}

func appendVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func decodeTag(b []byte) (field int, wire int, n int, err error) {
	v, n, err := decodeVarint(b)
	if err != nil {
		return 0, 0, 0, err
	}
	return int(v >> 3), int(v & 0x7), n, nil
}

func decodeVarint(b []byte) (uint64, int, error) {
	var v uint64
	var shift uint
	for i := 0; i < len(b); i++ {
		c := b[i]
		v |= uint64(c&0x7f) << shift
		if c < 0x80 {
			return v, i + 1, nil
		}
		shift += 7
		if shift > 63 {
			return 0, 0, errors.New("varint overflow")
		}
	}
	return 0, 0, errors.New("varint truncated")
}

func decodeString(b []byte) (string, int, error) {
	by, n, err := decodeBytes(b)
	if err != nil {
		return "", 0, err
	}
	return string(by), n, nil
}

func decodeBytes(b []byte) ([]byte, int, error) {
	length, n, err := decodeVarint(b)
	if err != nil {
		return nil, 0, err
	}
	if uint64(len(b)-n) < length {
		return nil, 0, errors.New("length-delimited overruns buffer")
	}
	out := make([]byte, length)
	copy(out, b[n:n+int(length)])
	return out, n + int(length), nil
}

// skipWire advances *b past one field whose tag has already been
// consumed. Used to keep us forward-compatible with future Pipecat
// fields without re-deploying.
func skipWire(b *[]byte, wire int) error {
	switch wire {
	case wireVarint: // varint
		_, n, err := decodeVarint(*b)
		if err != nil {
			return err
		}
		*b = (*b)[n:]
	case wireLen: // length-delimited
		length, n, err := decodeVarint(*b)
		if err != nil {
			return err
		}
		*b = (*b)[n:]
		if uint64(len(*b)) < length {
			return errors.New("skip: length-delimited overruns buffer")
		}
		*b = (*b)[length:]
	case 1: // fixed64
		if len(*b) < 8 {
			return errors.New("skip: fixed64 truncated")
		}
		*b = (*b)[8:]
	case 5: // fixed32
		if len(*b) < 4 {
			return errors.New("skip: fixed32 truncated")
		}
		*b = (*b)[4:]
	default:
		return fmt.Errorf("unknown wire type %d", wire)
	}
	return nil
}

// Silence the unused-import linter for binary in case future fields use
// fixed encodings.
var _ = binary.LittleEndian
