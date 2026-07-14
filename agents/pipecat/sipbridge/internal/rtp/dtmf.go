package rtp

// DTMFEvent is a parsed RFC 4733 telephony-event RTP payload.
//
// RFC 4733 §2.3 wire format (4 bytes for the event header; we don't
// need the optional Volume Indicator beyond byte 1):
//
//	 0                   1                   2                   3
//	 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//	+---------------+-+-+-+-+-+-+-+-+-+---------------+-------------+
//	|     event     |E|R|  volume   |          duration           |
//	+---------------+-+-+-+-+-+-+-+-+-+-----------------------------+
//
//	event:    1 byte — DTMF symbol (0-15 = 0-9 * # A-D)
//	E:        1 bit  — end-of-event flag
//	R:        1 bit  — reserved (must be 0)
//	volume:   6 bits — dBm0 magnitude (0-63)
//	duration: 16 bits — sample-count of the event so far
type DTMFEvent struct {
	Event    byte // 0–15 per RFC 4733 §2.1
	End      bool
	Volume   uint8 // 0–63 dBm0 magnitude
	Duration uint16
}

// Symbol returns the keypad symbol corresponding to ``Event``. Returns
// 0 for unknown values (defensive — RFC 4733 only defines 0–15 in
// the keypad-event range).
func (e DTMFEvent) Symbol() byte {
	switch e.Event {
	case 0, 1, 2, 3, 4, 5, 6, 7, 8, 9:
		return '0' + e.Event
	case 10:
		return '*'
	case 11:
		return '#'
	case 12:
		return 'A'
	case 13:
		return 'B'
	case 14:
		return 'C'
	case 15:
		return 'D'
	}
	return 0
}

// ParseDTMF unpacks a 4-byte RFC 4733 telephony-event payload. Returns
// (nil, false) if the buffer is too short — the caller drops the
// packet.
func ParseDTMF(payload []byte) (*DTMFEvent, bool) {
	if len(payload) < 4 {
		return nil, false
	}
	return &DTMFEvent{
		Event:    payload[0],
		End:      payload[1]&0x80 != 0,
		Volume:   payload[1] & 0x3F,
		Duration: uint16(payload[2])<<8 | uint16(payload[3]),
	}, true
}

// EventCode maps a keypad symbol to its RFC 4733 event code — the inverse
// of Symbol. Returns (code, true) for 0-9, * and #, and (0, false) for
// anything else. A-D (events 12-15) are intentionally rejected: the
// platform's DTMF alphabet is limited to what the worker's KeypadEntry
// surface carries end-to-end (0-9, * and #).
func EventCode(symbol byte) (byte, bool) {
	switch {
	case symbol >= '0' && symbol <= '9':
		return symbol - '0', true
	case symbol == '*':
		return 10, true
	case symbol == '#':
		return 11, true
	}
	return 0, false
}

// EncodeDTMF builds the 4-byte RFC 4733 telephony-event payload for one
// packet of an event: the event code, the End flag ORed with the 6-bit
// volume, and the 16-bit cumulative duration (in 8 kHz timestamp units).
// It is the inverse of ParseDTMF.
func EncodeDTMF(event byte, end bool, volume uint8, duration uint16) []byte {
	b1 := volume & 0x3F
	if end {
		b1 |= 0x80
	}
	return []byte{event, b1, byte(duration >> 8), byte(duration)}
}

// PayloadDTMF is the conventional dynamic payload type for RFC 4733
// telephony-events. Carriers advertise it via SDP attribute
// ``a=rtpmap:101 telephone-event/8000`` — we publish the same in our
// answer and accept it on receive.
const PayloadDTMF PayloadType = 101
