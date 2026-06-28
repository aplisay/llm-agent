package sip

import (
	"sync/atomic"
	"time"
)

// Process-wide monotonic SDP session-id counter. RFC 4566 says the id
// should be "unique" without further constraint; we use unix-time start
// + monotonic counter so consecutive answers don't reuse the same id
// across a restart either.
var sessIDCounter = func() *atomic.Int64 {
	c := &atomic.Int64{}
	c.Store(time.Now().Unix())
	return c
}()
