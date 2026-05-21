// Command sipbridge: minimal SIP-to-Pipecat WebSocket bridge.
//
// Phase A: accept inbound INVITEs, negotiate G.711, bridge audio to a
// Pipecat worker over WebSocket. See docs/sipbridge-integration.md for
// the architecture overview and the per-phase scope.
package main

import (
	"context"
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
	sipx "github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/sip"
)

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnixMs
	log.Logger = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339}).
		With().Timestamp().Logger()

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

	// Wire components.
	mgr := call.New(call.Config{
		WorkerWSBase: cfg.WorkerWSBase,
		MediaIP:      cfg.MediaIP,
		MediaBindIP:  cfg.MediaBindIP,
		RTPPortMin:   cfg.RTPPortMin,
		RTPPortMax:   cfg.RTPPortMax,
	})

	sipSrv, err := sipx.NewServer(sipx.Config{
		SignalIP:   cfg.SIPSignalIP,
		SignalPort: cfg.SIPSignalPort,
		BindIP:     cfg.SIPBindIP,
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
		// Build the cert before spawning the listener goroutine so we
		// can fail fast (and log the fingerprint synchronously) instead
		// of swallowing the error in a goroutine.
		cert, fp, selfSigned, err := sipx.LoadOrGenerateCert(
			cfg.TLSCertFile,
			cfg.TLSKeyFile,
			[]string{cfg.SIPSignalIP, "sipbridge"},
		)
		if err != nil {
			log.Fatal().Err(err).Msg("sip: TLS cert setup")
		}
		certLog := log.Info().Str("sha256_fingerprint", fp)
		if selfSigned {
			certLog = certLog.Bool("self_signed", true).
				Str("hint", "configure your upstream SBC to skip TLS cert validation, or mount a real cert via SIPBRIDGE_TLS_CERT_FILE/_KEY_FILE")
		} else {
			certLog = certLog.Str("source", cfg.TLSCertFile)
		}
		certLog.Msg("sip: TLS cert ready")
		go func() {
			if err := sipSrv.ListenTLS(ctx, cfg.TLSSignalPort, cert); err != nil && !errors.Is(err, context.Canceled) {
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
		log.Info().Msg("sipbridge: signal received, shutting down")
	case err := <-errCh:
		if err != nil {
			log.Error().Err(err).Msg("sipbridge: component failed, shutting down")
		}
		cancel()
	}

	// Graceful shutdown — bound it so a stuck connection doesn't pin
	// the process forever.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
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
