// DTLS-SRTP (RFC 5764) handshake on the existing RTP UDP socket.
//
// Flow on the inbound call path (we're the SIP UAS):
//
//  1. The Session is created (UDP socket bound), readLoop NOT yet
//     started — the call manager defers Start() until handshake done.
//  2. SDP answer goes out announcing our cert fingerprint and a=setup
//     role (typically "passive" — we're the DTLS server).
//  3. Peer (DTLS client) sends ClientHello to our RTP port.
//  4. This file: pion/dtls runs the handshake against a wrapper around
//     our UDP socket. We verify the peer cert's SHA-* fingerprint
//     matches what the SDP advertised.
//  5. Once handshaken, we ExportKeyingMaterial (RFC 5705 with the
//     "EXTRACTOR-dtls_srtp" label, RFC 5764 §4.2), derive per-direction
//     master keys + salts, and install pion/srtp Contexts on the
//     Session.
//  6. Close the DTLS Conn — our wrapper's Close is a no-op on the
//     underlying UDP socket, so it survives intact.
//  7. Call manager then runs Session.Start() and the regular SRTP
//     read/write path takes over.
//
// We don't currently demux DTLS rehandshake / control packets on the
// running RTP socket. If the peer initiates a rehandshake mid-call
// those packets will be discarded by the SRTP context (unauthenticated
// junk); rekey-during-call is a Phase-G+ follow-up.

package rtp

import (
	"context"
	"crypto/sha1"   //nolint:gosec // fingerprint comparison only, not for hashing secrets
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"net"
	"strings"
	"sync/atomic"
	"time"

	dtlsv3 "github.com/pion/dtls/v3"
	srtpv3 "github.com/pion/srtp/v3"
)

// RunDTLSSRTPHandshake performs the DTLS handshake on the Session's
// UDP socket, verifies the peer's cert against the supplied SDP
// fingerprint, derives SRTP master keys + salts from the keying
// material, and installs them on the Session.
//
// Caller must not have started the Session's read loop yet — DTLS
// needs exclusive access to the socket for the handshake. After this
// returns successfully, the caller calls Session.Start() to begin
// regular SRTP traffic.
//
// ``isClient`` is true when our SDP answer chose ``a=setup:active``
// (we initiate the DTLS handshake), false when ``a=setup:passive``
// (peer initiates; we're the DTLS server).
//
// ``peerFingerprintAlgo`` is lowercased ("sha-256", "sha-1", "sha-512");
// ``peerFingerprintHex`` is the colon-separated upper-case hex form.
func RunDTLSSRTPHandshake(
	ctx context.Context,
	sess *Session,
	cert *tls.Certificate,
	peerFingerprintAlgo string,
	peerFingerprintHex string,
	isClient bool,
) error {
	if cert == nil {
		return errors.New("dtls-srtp: no certificate configured")
	}
	if peerFingerprintAlgo == "" || peerFingerprintHex == "" {
		return errors.New("dtls-srtp: peer fingerprint missing")
	}
	hashFn, err := hashForFingerprintAlgo(peerFingerprintAlgo)
	if err != nil {
		return err
	}
	peerExpected := strings.ToUpper(strings.ReplaceAll(peerFingerprintHex, ":", ""))

	// pion/dtls's Server / Client expect the peer's UDP address so it
	// can ignore handshake packets from random hosts. We've already
	// learned that from SDP and stamped it on the Session via SetRemote.
	peerAddr := sess.remoteAddr.Load()
	if peerAddr == nil {
		return errors.New("dtls-srtp: peer RTP address not set on Session")
	}

	wrapped := &nopCloseUDPConn{conn: sess.conn}

	supportedProfiles := make([]dtlsv3.SRTPProtectionProfile, 0, len(SRTPSuites))
	for _, s := range SRTPSuites {
		supportedProfiles = append(supportedProfiles, s.DTLSProfile)
	}

	cfg := &dtlsv3.Config{
		Certificates:           []tls.Certificate{*cert},
		SRTPProtectionProfiles: supportedProfiles,
		// We verify the peer's cert by SDP fingerprint, not by CA
		// chain. Disable the default chain verification and plug in
		// a VerifyPeerCertificate that hashes the cert and compares
		// to peerExpected.
		InsecureSkipVerify: true,
		// ClientAuth = RequireAnyClientCert ensures the peer presents
		// a cert in the server path; without this we can't verify
		// the fingerprint.
		ClientAuth: dtlsv3.RequireAnyClientCert,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("dtls-srtp: peer presented no certificate")
			}
			got := hashFn()
			got.Write(rawCerts[0])
			gotHex := strings.ToUpper(hex.EncodeToString(got.Sum(nil)))
			if gotHex != peerExpected {
				return fmt.Errorf("dtls-srtp: peer cert fingerprint mismatch (got %s, expected %s)",
					gotHex, peerExpected)
			}
			return nil
		},
	}

	// The handshake itself. pion/dtls handles the message-flight retransmit
	// for us; we just need to cap how long we'll wait for the peer.
	hsCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	type result struct {
		conn *dtlsv3.Conn
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		var c *dtlsv3.Conn
		var err error
		if isClient {
			c, err = dtlsv3.Client(wrapped, peerAddr, cfg)
		} else {
			c, err = dtlsv3.Server(wrapped, peerAddr, cfg)
		}
		resCh <- result{conn: c, err: err}
	}()
	var dconn *dtlsv3.Conn
	select {
	case r := <-resCh:
		if r.err != nil {
			return fmt.Errorf("dtls-srtp: handshake: %w", r.err)
		}
		dconn = r.conn
	case <-hsCtx.Done():
		return fmt.Errorf("dtls-srtp: handshake: %w", hsCtx.Err())
	}

	// Recover the negotiated suite + keying material.
	negotiatedProfile, ok := dconn.SelectedSRTPProtectionProfile()
	if !ok {
		_ = dconn.Close()
		return errors.New("dtls-srtp: peer didn't agree any SRTP protection profile")
	}
	suite, ok := SuiteByDTLSProfile(negotiatedProfile)
	if !ok {
		_ = dconn.Close()
		return fmt.Errorf("dtls-srtp: negotiated unknown protection profile %#v", negotiatedProfile)
	}

	state, ok := dconn.ConnectionState()
	if !ok {
		_ = dconn.Close()
		return errors.New("dtls-srtp: connection state unavailable after handshake")
	}
	// RFC 5764 §4.2: total exported length = 2*(KeyLen + SaltLen).
	wantLen := 2 * (suite.MasterKeyLen + suite.MasterSaltLen)
	keying, err := state.ExportKeyingMaterial("EXTRACTOR-dtls_srtp", nil, wantLen)
	if err != nil {
		_ = dconn.Close()
		return fmt.Errorf("dtls-srtp: ExportKeyingMaterial: %w", err)
	}
	if len(keying) != wantLen {
		_ = dconn.Close()
		return fmt.Errorf("dtls-srtp: keying material is %d bytes, expected %d", len(keying), wantLen)
	}
	clientKey, serverKey, clientSalt, serverSalt := splitDTLSKeying(keying, suite)

	// Map DTLS client/server roles → SRTP inbound/outbound contexts
	// for OUR side. Whichever side we are (DTLS client or server), we
	// always:
	//   - DECRYPT with the peer's master key (inbound)
	//   - ENCRYPT with our master key (outbound)
	var inMaster, outMaster []byte
	var inSalt, outSalt []byte
	if isClient {
		// We're the DTLS client → peer is DTLS server → peer encrypts
		// with serverKey → we decrypt with serverKey; we encrypt with
		// clientKey.
		inMaster, inSalt = serverKey, serverSalt
		outMaster, outSalt = clientKey, clientSalt
	} else {
		// We're the DTLS server → peer is client → peer encrypts with
		// clientKey → we decrypt with clientKey; we encrypt with
		// serverKey.
		inMaster, inSalt = clientKey, clientSalt
		outMaster, outSalt = serverKey, serverSalt
	}

	inboundCtx, err := srtpv3.CreateContext(inMaster, inSalt, suite.PionProfile)
	if err != nil {
		_ = dconn.Close()
		return fmt.Errorf("dtls-srtp: build inbound SRTP context: %w", err)
	}
	outboundCtx, err := srtpv3.CreateContext(outMaster, outSalt, suite.PionProfile)
	if err != nil {
		_ = dconn.Close()
		return fmt.Errorf("dtls-srtp: build outbound SRTP context: %w", err)
	}
	if err := sess.SetSRTPContexts(inboundCtx, outboundCtx); err != nil {
		_ = dconn.Close()
		return fmt.Errorf("dtls-srtp: install SRTP contexts: %w", err)
	}

	// Close the DTLS Conn. Our wrapper's Close is a no-op on the
	// underlying UDP socket so it survives intact for SRTP. The DTLS
	// internal goroutines wake up via the SetReadDeadline(now) the
	// wrapper performs on Close.
	_ = dconn.Close()
	// Reset the read deadline our wrapper set, so the rtp.Session
	// readLoop's per-iteration SetReadDeadline starts cleanly.
	_ = sess.conn.SetReadDeadline(time.Time{})
	return nil
}

// splitDTLSKeying carves the exported keying material into the four
// RFC 5764 §4.2 components: client_write_SRTP_master_key,
// server_write_SRTP_master_key, client_write_SRTP_master_salt,
// server_write_SRTP_master_salt — in that order.
func splitDTLSKeying(keying []byte, suite SRTPSuite) (clientKey, serverKey, clientSalt, serverSalt []byte) {
	kLen, sLen := suite.MasterKeyLen, suite.MasterSaltLen
	clientKey = keying[0:kLen]
	serverKey = keying[kLen : 2*kLen]
	clientSalt = keying[2*kLen : 2*kLen+sLen]
	serverSalt = keying[2*kLen+sLen : 2*(kLen+sLen)]
	return
}

// hashForFingerprintAlgo returns a new hash.Hash matching the
// ``a=fingerprint:`` algorithm identifier from SDP. We support the
// three algorithms RFC 8122 / 8842 require WebRTC implementations to
// accept: sha-1 (legacy interop only), sha-256 (default), sha-512.
func hashForFingerprintAlgo(algo string) (func() hash.Hash, error) {
	switch strings.ToLower(strings.TrimSpace(algo)) {
	case "sha-1", "sha1":
		return sha1.New, nil
	case "sha-256", "sha256":
		return sha256.New, nil
	case "sha-512", "sha512":
		return sha512.New, nil
	}
	return nil, fmt.Errorf("dtls-srtp: unsupported fingerprint algorithm %q", algo)
}

// nopCloseUDPConn wraps a *net.UDPConn for pion/dtls. Its Close is a
// no-op on the underlying socket — we need to "release" the conn from
// the DTLS layer after the handshake without closing the UDP port,
// because the same port is then used for SRTP. The single side-effect
// of Close is setting a past read deadline, which wakes up any pending
// dtls Read so the dtls goroutine exits cleanly.
type nopCloseUDPConn struct {
	conn   *net.UDPConn
	closed atomic.Bool
}

func (w *nopCloseUDPConn) ReadFrom(p []byte) (int, net.Addr, error) {
	if w.closed.Load() {
		return 0, nil, net.ErrClosed
	}
	n, addr, err := w.conn.ReadFromUDP(p)
	if addr == nil {
		return n, nil, err
	}
	return n, addr, err
}

func (w *nopCloseUDPConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	return w.conn.WriteTo(p, addr)
}

func (w *nopCloseUDPConn) Close() error {
	w.closed.Store(true)
	// Wake any pending Read by giving it a past deadline. We
	// deliberately don't call w.conn.Close — the surrounding rtp
	// Session is going to keep using this socket for SRTP.
	return w.conn.SetReadDeadline(time.Now())
}

func (w *nopCloseUDPConn) LocalAddr() net.Addr  { return w.conn.LocalAddr() }
func (w *nopCloseUDPConn) SetDeadline(t time.Time) error      { return w.conn.SetDeadline(t) }
func (w *nopCloseUDPConn) SetReadDeadline(t time.Time) error  { return w.conn.SetReadDeadline(t) }
func (w *nopCloseUDPConn) SetWriteDeadline(t time.Time) error { return w.conn.SetWriteDeadline(t) }
