// TLS certificate loading & ephemeral self-signed generation for the
// sipbridge SIPS listener.
//
// Production deployments typically mount a real cert (Let's Encrypt,
// internal CA, …) and point SIPBRIDGE_TLS_CERT_FILE / KEY_FILE at it.
// Development / single-tenant deployments where the upstream SBC can be
// configured to skip cert validation get an ephemeral self-signed cert
// generated at startup — no external tooling (certbot, mkcert) needed.
//
// The ephemeral cert is fresh every restart. If the SBC pins
// certificate fingerprints (rather than just "accept any"), provide a
// real cert via the file path env vars instead.
package sip

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"fmt"
	"math/big"
	"net"
	"strings"
	"time"
)

// LoadOrGenerateCert returns a usable TLS certificate. If either
// ``certFile`` or ``keyFile`` is empty, an ephemeral self-signed cert
// is generated covering the supplied host names / IPs.
//
// Returns the cert, its SHA-256 fingerprint (hex-encoded, ":"-separated
// pairs like ``openssl x509 -fingerprint`` emits — useful for log /
// pinning), and ``selfSigned`` indicating which path was taken.
func LoadOrGenerateCert(certFile, keyFile string, hosts []string) (tls.Certificate, string, bool, error) {
	if certFile != "" && keyFile != "" {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			return tls.Certificate{}, "", false, fmt.Errorf("sip: load TLS cert/key %q + %q: %w", certFile, keyFile, err)
		}
		return cert, fingerprintOf(cert), false, nil
	}
	if certFile != "" || keyFile != "" {
		return tls.Certificate{}, "", false, fmt.Errorf("sip: TLS cert and key must both be set or both empty (got cert=%q, key=%q)", certFile, keyFile)
	}
	cert, err := generateSelfSignedCert(hosts)
	if err != nil {
		return tls.Certificate{}, "", false, fmt.Errorf("sip: generate ephemeral self-signed cert: %w", err)
	}
	return cert, fingerprintOf(cert), true, nil
}

// generateSelfSignedCert mints a fresh ECDSA P-256 / SHA-256 cert valid
// for one year, covering the supplied host names (DNS SANs) and IPs
// (IP SANs). The first host becomes the CN for legacy clients that
// still look at it.
//
// ECDSA over RSA because: shorter handshake, no parameter generation
// pause at startup, and every modern TLS stack supports it. P-256 is
// the lowest-common-denominator curve.
func generateSelfSignedCert(hosts []string) (tls.Certificate, error) {
	if len(hosts) == 0 {
		hosts = []string{"sipbridge"}
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("ecdsa keygen: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("serial: %w", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: hosts[0], Organization: []string{"Aplisay sipbridge (self-signed)"}},
		NotBefore:             time.Now().Add(-1 * time.Hour), // tolerate small clock skew
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	for _, h := range hosts {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
			continue
		}
		tmpl.DNSNames = append(tmpl.DNSNames, h)
	}
	// Always include loopback so the bridge can verify itself locally
	// (useful for health checks, future mTLS introspection).
	tmpl.IPAddresses = append(tmpl.IPAddresses, net.ParseIP("127.0.0.1"), net.ParseIP("::1"))

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("CreateCertificate: %w", err)
	}
	return tls.Certificate{
		Certificate: [][]byte{der},
		PrivateKey:  priv,
		Leaf:        &tmpl,
	}, nil
}

// fingerprintOf returns the SHA-256 fingerprint of the leaf cert in
// ``aa:bb:cc:…`` form, matching what ``openssl x509 -fingerprint
// -sha256`` prints.
func fingerprintOf(cert tls.Certificate) string {
	if len(cert.Certificate) == 0 {
		return ""
	}
	sum := sha256.Sum256(cert.Certificate[0])
	hex := hex.EncodeToString(sum[:])
	out := make([]byte, 0, len(hex)+len(hex)/2)
	for i := 0; i < len(hex); i += 2 {
		if i > 0 {
			out = append(out, ':')
		}
		out = append(out, hex[i], hex[i+1])
	}
	return strings.ToUpper(string(out))
}
