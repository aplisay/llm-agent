// Command sipbridge: minimal SIP-to-Pipecat WebSocket bridge.
//
// Phase A: accept inbound INVITEs, negotiate G.711, bridge audio to a
// Pipecat worker over WebSocket. See docs/sipbridge-integration.md for
// the architecture overview and the per-phase scope.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/api"
	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/call"
	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/config"
	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/secretenv"
	sipx "github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/sip"
)

// drainTimeout bounds the whole SIGTERM shutdown: BYE every live call,
// then drain the API server. Keep it comfortably under the pod's
// terminationGracePeriodSeconds (default 30 s) so the process exits on
// its own rather than being SIGKILLed mid-drain.
const drainTimeout = 20 * time.Second

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnixMs
	log.Logger = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339}).
		With().Timestamp().Logger()

	// Decrypt SECRETENV_BUNDLE into the environment before reading config, so a
	// single SECRETENV_KEY + SECRETENV_BUNDLE secret can carry SIPBRIDGE_API_TOKEN,
	// the PIPECAT_SIP_* outbound-trunk credentials, etc. No-op when unset.
	if err := secretenv.Load(); err != nil {
		log.Warn().Err(err).Msg("secretenv: bundle present but could not be loaded")
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("config load")
	}
	setLogLevel(cfg.LogLevel)

	udpDesc := fmt.Sprintf("%s:%d", cfg.SIPSignalIP, cfg.SIPSignalPort)
	if cfg.UDPDisabled {
		udpDesc = "disabled"
	}
	tlsDesc := "disabled"
	if cfg.TLSEnabled {
		tlsDesc = fmt.Sprintf("%s:%d", cfg.SIPSignalIP, cfg.TLSSignalPort)
	}
	log.Info().
		Str("sip_udp", udpDesc).
		Str("sip_tls", tlsDesc).
		Str("media_ip", cfg.MediaIP).
		Int("rtp_min", cfg.RTPPortMin).
		Int("rtp_max", cfg.RTPPortMax).
		Str("worker_ws", cfg.WorkerWSBase).
		Msg("sipbridge: starting")

	// Build the TLS cert up front (if either TLS signalling OR
	// DTLS-SRTP is enabled). Same cert / fingerprint covers both:
	// the SIP TLS listener uses it for signalling, the DTLS-SRTP
	// handshake uses it for media identity. Single identity = one
	// thing to provision, one fingerprint for the SBC to trust.
	var (
		mediaCert        *tls.Certificate
		mediaFingerprint string
	)
	wantDTLS := cfg.SRTPEnabled && cfg.SRTPDTLSEnabled
	if cfg.TLSEnabled || wantDTLS {
		cert, fp, selfSigned, err := sipx.LoadOrGenerateCert(
			cfg.TLSCertFile,
			cfg.TLSKeyFile,
			[]string{cfg.SIPSignalIP, "sipbridge"},
		)
		if err != nil {
			log.Fatal().Err(err).Msg("sip: TLS cert setup")
		}
		certLog := log.Info().
			Str("sha256_fingerprint", fp).
			Bool("for_sip_tls", cfg.TLSEnabled).
			Bool("for_dtls_srtp", wantDTLS)
		if selfSigned {
			certLog = certLog.Bool("self_signed", true).
				Str("hint", "configure your upstream SBC to skip TLS+DTLS cert validation, or mount a real cert via SIPBRIDGE_TLS_CERT_FILE/_KEY_FILE")
		} else {
			certLog = certLog.Str("source", cfg.TLSCertFile)
		}
		certLog.Msg("sip: TLS cert ready")
		mediaCert = &cert
		mediaFingerprint = "sha-256 " + fp
	}

	// Wire components.
	callCfg := call.Config{
		WorkerWSBase:      cfg.WorkerWSBase,
		MediaIP:           cfg.MediaIP,
		MediaBindIP:       cfg.MediaBindIP,
		RTPPortMin:        cfg.RTPPortMin,
		RTPPortMax:        cfg.RTPPortMax,
		RTPTimeoutSeconds: cfg.RTPTimeoutSeconds,
		RTPSilenceFill:    cfg.RTPSilenceFill,
		SRTPEnabled:       cfg.SRTPEnabled,
		SRTPRequired:      cfg.SRTPRequired,
		SRTPDTLSEnabled:   cfg.SRTPDTLSEnabled,
		SRTPOutbound:      cfg.SRTPOutbound,
	}
	if wantDTLS {
		callCfg.DTLSCert = mediaCert
		callCfg.DTLSFingerprint = mediaFingerprint
	}
	mgr := call.New(callCfg)

	sipSrv, err := sipx.NewServer(sipx.Config{
		SignalIP:      cfg.SIPSignalIP,
		SignalPort:    cfg.SIPSignalPort,
		TLSSignalPort: cfg.TLSSignalPort,
		BindIP:        cfg.SIPBindIP,
		AuthUsername:  cfg.SIPAuthUsername,
		AuthPassword:  cfg.SIPAuthPassword,
		FromDomain:    cfg.SIPFromDomain,
		TraceEnabled:  cfg.SIPTraceEnabled,
	})
	if err != nil {
		log.Fatal().Err(err).Msg("sip server")
	}
	mgr.RegisterSIP(sipSrv)

	apiSrv := api.New(mgr, cfg.APIBindAddr, cfg.APIBearerToken)

	// Run components in parallel; the first one to return cancels the rest.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Component count: API is always-on; UDP SIP and TLS SIP listeners
	// are each optional. Sized to 3 so we can fit all three pushes
	// without blocking, even when one transport is disabled (the third
	// just never sends).
	errCh := make(chan error, 3)
	if !cfg.UDPDisabled {
		go func() {
			if err := sipSrv.Listen(ctx); err != nil && !errors.Is(err, context.Canceled) {
				errCh <- fmt.Errorf("sip (UDP): %w", err)
				return
			}
			errCh <- nil
		}()
	} else {
		log.Info().Msg("sip: UDP listener disabled by config (TLS-only mode)")
	}
	if cfg.TLSEnabled {
		// Cert was already built above so DTLS-SRTP and SIP TLS share
		// the same identity. The pointer-deref is safe because the
		// "build cert" block runs when TLSEnabled or wantDTLS is true,
		// which is a superset of TLSEnabled.
		tlsCert := *mediaCert
		go func() {
			if err := sipSrv.ListenTLS(ctx, cfg.TLSSignalPort, tlsCert); err != nil && !errors.Is(err, context.Canceled) {
				errCh <- fmt.Errorf("sip (TLS): %w", err)
				return
			}
			errCh <- nil
		}()
	}
	go func() {
		if err := apiSrv.ListenAndServe(); err != nil {
			errCh <- fmt.Errorf("api: %w", err)
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		log.Info().Msg("sipbridge: signal received, draining")
	case err := <-errCh:
		if err != nil {
			log.Error().Err(err).Msg("sipbridge: component failed, shutting down")
		}
		cancel()
	}

	// Graceful shutdown — bound it so a stuck connection doesn't pin
	// the process forever.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), drainTimeout)
	defer cancelShutdown()
	// Drain before anything else: stop answering new INVITEs (503 +
	// Retry-After, so the upstream re-routes) and then BYE every live
	// dialog. Without this a rolling update abandons every call on the
	// node without signalling — the carrier holds its channels until
	// its own timers expire, and the worker only finds out when its
	// WebSocket dies.
	sipSrv.Drain()
	if n := mgr.HangupAll(shutdownCtx); n > 0 {
		log.Info().Int("calls", n).Msg("sipbridge: drained active calls")
	}
	if err := apiSrv.Shutdown(shutdownCtx); err != nil {
		log.Warn().Err(err).Msg("api: shutdown")
	}
	if err := sipSrv.Close(); err != nil {
		log.Warn().Err(err).Msg("sip: close")
	}
	log.Info().Msg("sipbridge: stopped")
}

func setLogLevel(level string) {
	lvl, err := zerolog.ParseLevel(level)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)
}
