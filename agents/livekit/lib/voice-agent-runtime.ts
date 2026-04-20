import { voice } from "@livekit/agents";
import type { VAD } from "@livekit/agents";
import type { RemoteParticipant, Room } from "@livekit/rtc-node";
import { RoomEvent } from "@livekit/rtc-node";
import logger, { getCaptureStats } from "./logger.js";
import { withTimeout } from "./utils.js";
import { uploadRecorderIOToGcs } from "./call-recording.js";
import { setCallRecordingData, saveInvocationLog } from "./api-client.js";
import type { ParticipantInfo, SipParticipant } from "./types.js";
import type { RunAgentWorkerParams } from "./types.js";
import { DISCONNECT_REASONS, roomService } from "./livekit-constants.js";
import { invocationLogs } from "./invocation-log-buffer.js";
import { createTools } from "./agent-tools.js";
import { resolveVoiceMode } from "./voice-mode.js";
import { createVoiceModelAndSession } from "./voice-session-factory.js";

export async function runAgentWorker({
  ctx,
  room,
  agent,
  participant,
  callerId,
  calledId,
  modelName,
  metadata,
  sendMessage,
  call,
  onHangup,
  onTransfer,
  getBridgedParticipant,
  setBridgedParticipant,
  checkForHangup,
  sessionRef,
  modelRef,
  getConsultInProgress,
  getActiveCall,
  endTransferActivityIfNeeded,
  getTransferState,
  recordingOptions,
  transferOnly = false,
  transferArgs,
}: RunAgentWorkerParams & {
  endTransferActivityIfNeeded: (reason: string) => Promise<void>;
  getTransferState: () => {
    state: "none" | "dialling" | "talking" | "rejected" | "failed";
    description: string;
  };
}) {
  /** When true, recording uses SDK RecorderIO (pipeline tee); we upload OGG in cleanup. */
  let useRecorderIO = false;

  // If transferOnly mode, skip agent setup and go straight to transfer handling
  if (transferOnly && transferArgs && participant) {
    logger.info(
      { transferArgs, fallbackTransfer: true },
      "Running in transfer-only mode for fallback transfer",
    );

    // Set up participant disconnect handlers BEFORE transfer to ensure they're ready
    const disconnectHandler = async (p: RemoteParticipant) => {
      const bp = getBridgedParticipant();
      logger.info(
        {
          p: { sid: p?.info?.sid, identity: p?.info?.identity },
          bridgedParticipant: bp,
          originalParticipant: {
            sid: participant?.sid,
            identity: participant?.identity,
          },
          roomParticipants: (await roomService.listParticipants(room.name)).map(
            (pp) => ({ sid: pp.sid, identity: pp.identity }),
          ),
        },
        "participant disconnected (transfer-only mode)",
      );

      // Check if this is the bridged participant (transfer target)
      if (
        bp &&
        (bp.participantId === p?.info?.sid ||
          bp.participantIdentity === p?.info?.identity)
      ) {
        logger.info(
          "bridged participant disconnected, shutting down (transfer-only mode)",
        );
        try {
          await endTransferActivityIfNeeded(
            DISCONNECT_REASONS.BRIDGED_PARTICIPANT,
          );
        } catch (transferError) {
          logger.error(
            { transferError },
            "error ending transfer activity during bridged participant disconnect",
          );
        }
        await call.end(DISCONNECT_REASONS.BRIDGED_PARTICIPANT);
        await roomService.deleteRoom(room.name).catch((e) => {
          logger.error({ e }, "error deleting room");
        });
        invocationLogReason = DISCONNECT_REASONS.BRIDGED_PARTICIPANT;
        await ctx.shutdown(DISCONNECT_REASONS.BRIDGED_PARTICIPANT);
        process.exit(0);
      }
      // Check if this is the original participant (caller)
      else if (
        p.info?.sid === participant?.sid ||
        p.info?.identity === participant?.identity
      ) {
        logger.info(
          "original participant disconnected, shutting down (transfer-only mode)",
        );
        try {
          await endTransferActivityIfNeeded(
            DISCONNECT_REASONS.ORIGINAL_PARTICIPANT,
          );
        } catch (transferError) {
          logger.error(
            { transferError },
            "error ending transfer activity during original participant disconnect",
          );
        }
        await call.end(DISCONNECT_REASONS.ORIGINAL_PARTICIPANT);
        await roomService.deleteRoom(room.name).catch((e) => {
          logger.error({ e }, "error deleting room");
        });
        invocationLogReason = DISCONNECT_REASONS.ORIGINAL_PARTICIPANT;
        await ctx.shutdown(DISCONNECT_REASONS.ORIGINAL_PARTICIPANT);
        process.exit(0);
      } else {
        logger.debug(
          {
            disconnectedParticipant: {
              sid: p?.info?.sid,
              identity: p?.info?.identity,
            },
            bridgedParticipant: bp,
            originalParticipant: {
              sid: participant?.sid,
              identity: participant?.identity,
            },
          },
          "Unknown participant disconnected, ignoring",
        );
      }
    };

    ctx.room.on(RoomEvent.ParticipantDisconnected, disconnectHandler);

    // Reserve concurrency before connecting to the room.
    // Otherwise the SIP leg may be accepted and only rejected after call.start() fails.
    await call.start();
    await ctx.connect();
    sendMessage({ call: `${callerId} => ${calledId}` });
    sendMessage({
      agent: `Transferring call to ${transferArgs.number} due to agent failure`,
    });

    // Perform the transfer
    try {
      await onTransfer({
        args: transferArgs,
        participant,
      });
      logger.info(
        { transferArgs },
        "Fallback transfer initiated successfully in transfer-only mode",
      );
    } catch (transferError) {
      const tErr =
        transferError instanceof Error
          ? transferError
          : new Error(String(transferError));
      logger.error(
        {
          error: tErr,
          message: tErr.message,
          stack: tErr.stack,
          transferArgs,
        },
        "Fallback transfer failed in transfer-only mode",
      );
      await call.end(`Fallback transfer failed: ${tErr.message}`);
      await roomService.deleteRoom(room.name).catch((e) => {
        logger.error({ e }, "error deleting room");
      });
      await ctx.shutdown(tErr.message);
      return;
    }

    // In transfer-only mode, we just wait for the transfer to complete
    // The ParticipantDisconnected handler above will clean up when done
    // Don't return - let the function continue to keep the process alive
    // The handler will call process.exit(0) when cleanup is done
    return;
  }

  let timerId: NodeJS.Timeout | null = null;
  let operation: string | null = null;

  // Marker log to verify worker logger capture is included in InvocationLog
  logger.info(
    { tag: "invocation-log-test", callId: call.id },
    "worker app log test",
  );

  let session: voice.AgentSession | null = null;
  /** Recording + invocation logs must stay on the inbound agent call, not the bridged child call. */
  const primaryRecordingCallId = call.id;
  /**
   * When the bridged leg ends we call `session.close()` then `cleanupAndClose()`.
   * The Close handler must not delete the room / end the active call in between — that is cleanupAndClose's job.
   */
  let suppressNextSessionCloseRoomHandlers = false;
  let maxDuration: number = 305000; // Default value
  let callStarted = false;
  // Guard to ensure RecorderIO finalization/upload runs only once per job
  let recorderFinalized = false;

  // DTMF buffering: accumulate digits and send as a single input after timeout
  let dtmfBuffer: string = "";
  let dtmfTimeout: NodeJS.Timeout | null = null;
  const DTMF_TIMEOUT_MS = 1500; // 1.5 seconds of silence before sending
  const DTMF_TERMINATOR = "#"; // Send immediately when this is pressed

  let invocationLogPersisted = false;
  let invocationLogReason: string | null = null;

  const finalizeRecorderRecording = async () => {
    if (!useRecorderIO || recorderFinalized) {
      return;
    }
    recorderFinalized = true;

    // After blind-bridge teardown we null `session`; RecorderIO may already be closed inside
    // `session.close()`, but we still must upload from `sessionDirectory` using primaryCallId.
    const recorderIO = session
      ? (session as { _recorderIO?: { close(): Promise<void> } })._recorderIO
      : undefined;
    if (recorderIO) {
      try {
        logger.debug(
          { callId: primaryRecordingCallId },
          "RecorderIO: flushing recorder (close) in shutdown callback before upload",
        );
        await recorderIO.close();
        logger.debug(
          { callId: primaryRecordingCallId },
          "RecorderIO: flush complete in shutdown callback, OGG file ready",
        );
      } catch (e) {
        logger.warn(
          { e, callId: primaryRecordingCallId },
          "RecorderIO: error flushing recorder in shutdown callback, continuing to upload",
        );
      }
    } else {
      logger.debug(
        { callId: primaryRecordingCallId },
        "RecorderIO: no _recorderIO instance found on session in shutdown callback",
      );
    }

    const sessionDir = (ctx as { sessionDirectory?: string }).sessionDirectory;
    if (!sessionDir) {
      logger.warn(
        { callId: primaryRecordingCallId },
        "RecorderIO used but no session directory in shutdown callback; recording not persisted",
      );
      return;
    }

    try {
      const { gcsObject, serverGeneratedKey } = await uploadRecorderIOToGcs(
        sessionDir,
        primaryRecordingCallId,
        {
          clientEncryptionKey: recordingOptions?.key,
        },
      );
      await setCallRecordingData(
        primaryRecordingCallId,
        gcsObject,
        serverGeneratedKey,
      );
      logger.info(
        {
          callId: primaryRecordingCallId,
          gcsObject,
          hasServerKey: Boolean(serverGeneratedKey),
        },
        "uploaded RecorderIO recording to GCS from shutdown callback",
      );
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.warn(
        {
          callId: primaryRecordingCallId,
          message: error.message,
        },
        "RecorderIO OGG not found or upload failed in shutdown callback",
      );
    }
  };

  const persistInvocationLogIfAvailable = async (reason: string) => {
    console.log(
      "persistInvocationLogIfAvailable: checking if invocation logs are available",
      { reason, length: invocationLogs.length },
    );
    if (!invocationLogs.length) {
      console.log("No invocation logs to persist", {
        reason,
        length: invocationLogs.length,
      });
      logger.warn(
        { reason, length: invocationLogs.length },
        "Invocation log already persisted",
      );
      return;
    }
    invocationLogPersisted = true;

    try {
      // Debug snapshot of what we've actually captured before sorting/persisting
      const captureStats = getCaptureStats();
      logger.info(
        {
          reason,
          invocationLogsLength: invocationLogs.length,
          captureStats,
          invocationLogHeadSample: invocationLogs.slice(0, 3),
          invocationLogTailSample: invocationLogs.slice(-3),
        },
        "persistInvocationLogIfAvailable: debug snapshot before sort",
      );

      const ts = (e: unknown) => {
        const t = (e as { time?: number | string })?.time;
        if (typeof t === "number") return t;
        if (typeof t === "string") return new Date(t).getTime();
        return 0;
      };
      const sorted = [...invocationLogs].sort((a, b) => ts(a) - ts(b));
      console.log(
        { length: sorted.length },
        "persistInvocationLogIfAvailable: sorted invocation logs",
      );
      await saveInvocationLog({
        userId: call.userId,
        organisationId: call.organisationId,
        callId: primaryRecordingCallId,
        subsystem: "livekit-agent",
        log: {
          reason,
          logs: sorted,
        },
      });
      console.log("InvocationLog persisted for call", {
        callId: primaryRecordingCallId,
        entryCount: sorted.length,
      });
      logger.info(
        {
          callId: primaryRecordingCallId,
          entryCount: invocationLogs.length,
        },
        "InvocationLog persisted for call",
      );
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error("Failed to persist InvocationLog; continuing cleanup", {
        message: error.message,
        error,
        reason,
      });
      logger.warn(
        { message: error.message, error, reason },
        "Failed to persist InvocationLog; continuing cleanup",
      );
    }
  };

  try {
    ctx.addShutdownCallback(async () => {
      const reason = invocationLogReason || "shutdown";
      const captureStats = getCaptureStats();
      console.log(
        "shutdown callback: starting finalization and InvocationLog persistence",
        {
          reason,
          captureStats,
          invocationLogsLength: invocationLogs.length,
          invocationLogHeadSample: invocationLogs.slice(0, 3),
          invocationLogTailSample: invocationLogs.slice(-3),
        },
      );

      await finalizeRecorderRecording();
      console.log(
        "shutdown callback: recorder finalized, persisting InvocationLog",
        { reason },
      );

      await persistInvocationLogIfAvailable(reason);
      console.log("shutdown callback: InvocationLog persistence complete", {
        reason,
      });
    });
  } catch (e) {
    console.log(
      "shutdown callback: failed to register; RecorderIO upload or InvocationLog persistence may be skipped",
      { error: e },
    );
  }

  const cleanupAndClose = async (
    reason: string,
    logEndCall: boolean = false,
  ) => {
    const exitStatus: {
      callEnded: boolean;
      roomDeleted: boolean;
      contextShutdown: boolean;
      error: string | null;
    } = {
      callEnded: false,
      roomDeleted: false,
      contextShutdown: false,
      error: null,
    };

    // The room delete and ctx.shutdown should drain all processing and cause the process to exit,
    // but there is evidence in high load environments of zombie process buildup.
    // Force a hard exit after 120 seconds to avoid this until we figure out why.
    setTimeout(() => {
      logger.info(
        { exitStatus, reason },
        "timeout whilst closing room, forcing a hard process exit after 120 seconds",
      );
      process.exit(0);
    }, 120 * 1000).unref(); // Ensure *this* timer doesn't block process exit.

    try {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      // Clean up DTMF timeout if active
      if (dtmfTimeout) {
        clearTimeout(dtmfTimeout);
        dtmfTimeout = null;
      }
      // Flush any pending DTMF buffer before closing
      if (dtmfBuffer.length > 0 && session) {
        logger.debug(
          { buffer: dtmfBuffer },
          "Flushing remaining DTMF buffer during cleanup",
        );
        try {
          session.generateReply({ userInput: dtmfBuffer });
        } catch (e) {
          logger.debug({ e }, "Failed to flush DTMF buffer during cleanup");
        }
        dtmfBuffer = "";
      }


      await getActiveCall()
        .end(reason)
        .catch((e) => {
          logger.error({ e }, "error ending call");
        });
      exitStatus.callEnded = true;
      logger.debug("cleanup and close: call ended, deleting room");
      await roomService.deleteRoom(room.name).catch((e) => {
        logger.error({ e }, "error deleting room");
      });
      exitStatus.roomDeleted = true;

      invocationLogReason = reason;
      logger.debug("cleanup and close: shutting down context");
      await ctx.shutdown(reason);
      logger.debug("cleanup and close: context shutdown complete");
      exitStatus.contextShutdown = true;
      logger.info({ exitStatus, reason }, "cleanup and close completed");
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.info(
        { message: error.message, error },
        "error cleaning up and closing",
      );
      exitStatus.error =
        error.message || "unknown error caught during cleanup and close";
    }
  };

  try {
    // Wrap setup operations with timeout
    await withTimeout(
      async () => {
        operation = "createTools";
        const tools = createTools({
          agent,
          call,
          room: room!,
          participant,
          sendMessage,
          metadata,
          onHangup,
          onTransfer,
          getTransferState,
        });

        operation = "createModel";
        const maxDurationString: string = agent?.options?.maxDuration || "305s";
        maxDuration =
          1000 * parseInt(maxDurationString.match(/(\d+)s/)?.[1] || "305");

        const voiceMode = resolveVoiceMode(modelName, agent.options);
        const vad =
          voiceMode === "pipeline"
            ? (ctx.proc.userData as { vad?: VAD }).vad
            : undefined;

        logger.debug({ tools, voiceMode, hasVad: Boolean(vad) }, "Creating model and session");
        const { session: builtSession, model } = createVoiceModelAndSession({
          voiceMode,
          modelName,
          agent,
          call,
          tools,
          vad,
        });
        /** Skip echo of opening user line (Ultravox) and empty STT placeholders. */
        const initialUserTranscriptToSkip =
          agent.options?.vendorSpecific?.ultravox?.firstSpeakerSettings?.user?.fallback?.text?.trim() ??
          "";
        session = builtSession;
        modelRef(model);
        sessionRef(session);

        // Listen on all the things for now (debug)
        Object.keys(voice.AgentSessionEventTypes).forEach((event) => {
          session?.on(
            voice.AgentSessionEventTypes[
              event as keyof typeof voice.AgentSessionEventTypes
            ],
            (data: unknown) => {
              logger.debug({ data }, `Got event ${event}`);
            },
          );
        });

        // Listen on the user input transcribed event
        session.on(
          voice.AgentSessionEventTypes.ConversationItemAdded,
          ({
            item: { type, role, content },
            createdAt,
          }: voice.ConversationItemAddedEvent) => {
            if (type === "message" && getConsultInProgress() === false) {
              const text = content.join("");
              if (role !== "user" || text !== initialUserTranscriptToSkip) {
                sendMessage(
                  {
                    [role === "user" ? "user" : "agent"]: text,
                  },
                  createdAt ? new Date(createdAt) : undefined,
                );
              }
            }
          },
        );

        session.on(
          voice.AgentSessionEventTypes.AgentStateChanged,
          async (ev: voice.AgentStateChangedEvent) => {
            logger.debug({ ev, checkForHangup: checkForHangup(), roomName: room.name }, "agent state changed");
            sendMessage({ status: ev.newState });
            if (ev.newState === "listening" && checkForHangup() && room.name) {
              logger.debug({ room }, "room close inititiated");
              // End transfer activity if in progress (fire and forget)
              endTransferActivityIfNeeded(
                DISCONNECT_REASONS.AGENT_INITIATED_HANGUP,
              ).catch((transferError) => {
                logger.error(
                  { transferError },
                  "error ending transfer activity during hangup",
                );
              });
              await cleanupAndClose(DISCONNECT_REASONS.AGENT_INITIATED_HANGUP);
            }
          },
        );

        session.on(
          voice.AgentSessionEventTypes.Error,
          (ev: voice.ErrorEvent) => {
            logger.error({ ev }, "error");
          },
        );

        // Watch for any non-recoverable model/STT/TTS errors that occur while
        // the session is still starting. If we see one before callStarted is
        // set, we treat it as a setup failure so the outer fallback loop can
        // switch models/agents or perform a transfer.
        let startupErrorUnsubscribe: (() => void) | null = null;
        const startupErrorPromise = new Promise<never>((_, reject) => {
          const sessionForStartup = session;
          if (!sessionForStartup) {
            // Should not happen, but fail fast if it does.
            reject(
              new Error(
                "Agent session not available during startup error monitoring",
              ),
            );
            return;
          }

          const handler = (ev: voice.ErrorEvent) => {
            // If the call has already been marked as started, this is a
            // runtime error and should not influence startup / fallback logic.
            if (callStarted) {
              return;
            }

            const errAny: any = ev.error;
            const errType = errAny?.type;
            const isRealtimeModelError = errType === "realtime_model_error";
            const isRecoverable = !!errAny?.recoverable;

            // Ignore explicitly recoverable realtime model errors during startup.
            if (isRealtimeModelError && isRecoverable) {
              return;
            }

            // For any other error type (or non‑recoverable realtime model
            // error), treat this as a fatal startup failure.
            if (startupErrorUnsubscribe) {
              startupErrorUnsubscribe();
            }

            const underlyingError: Error =
              isRealtimeModelError && errAny?.error instanceof Error
                ? errAny.error
                : errAny instanceof Error
                  ? errAny
                  : new Error(
                      String(
                        errAny?.message ||
                          "Agent session startup error (realtime model / STT / TTS)",
                      ),
                    );

            reject(underlyingError);
          };

          sessionForStartup.on(
            voice.AgentSessionEventTypes.Error,
            handler as any,
          );
          startupErrorUnsubscribe = () => {
            const unsubscribeSession = sessionForStartup;
            if (unsubscribeSession) {
              unsubscribeSession.off(
                voice.AgentSessionEventTypes.Error,
                handler as any,
              );
            }
            startupErrorUnsubscribe = null;
          };
        });

        session.on(
          voice.AgentSessionEventTypes.Close,
          (ev: voice.CloseEvent) => {
            logger.info({ ev }, "session closed");
            // End transfer activity if in progress (non-blocking; listener stays synchronous
            // so `suppressNextSessionCloseRoomHandlers` is not raced by `finally` after `session.close()`).
            void endTransferActivityIfNeeded(
              DISCONNECT_REASONS.SESSION_CLOSED,
            ).catch((transferError) => {
              logger.error(
                { transferError },
                "error ending transfer activity during session close",
              );
            });
            // Blind bridge: bridged-leg cleanup calls `session.close()` then `cleanupAndClose()`.
            // Skip room delete / active-call end here so the bridged call is not torn down twice.
            if (suppressNextSessionCloseRoomHandlers) {
              suppressNextSessionCloseRoomHandlers = false;
              logger.info(
                {},
                "session close with deferred room/call cleanup (bridged teardown sequence)",
              );
              return;
            }
            void roomService.deleteRoom(room.name).catch((e) => {
              logger.error({ e }, "error deleting room on session close");
            });
            void getActiveCall()
              .end(DISCONNECT_REASONS.SESSION_CLOSED)
              .catch((e) => {
                logger.error({ e }, "error ending call on session close");
              });
          },
        );

        // Recording: enable RecorderIO (SDK pipeline tee → audio.ogg) when session directory is set.
        if (!transferOnly && recordingOptions && recordingOptions.enabled) {
          useRecorderIO = true;
          logger.info({ callId: call.id }, "recording enabled via RecorderIO");

          // Defer RecorderIO finalization & upload to a shutdown callback so we only
          // persist the recording after the entire AgentSession / Ultravox pipeline
          // has finished and the job is shutting down.
        }

        logger.debug(
          { call },
          "session started, setting up call (reserving concurrency before connecting to room)",
        );
        // Reserve concurrency before connecting to the LiveKit room.
        // This ensures concurrency failures are surfaced as immediate "busy"
        // rejections rather than connect-then-drop behaviour.
        await call.start();
        callStarted = true;
        logger.debug({ call }, "concurrency reserved, starting session");

        logger.info({ session }, "Starting session");
        operation = "sessionStart";
        logger.info(
          { callId: call.id, record: recordingOptions?.enabled ?? false },
          "sessionStart with recording? enabled",
        );
        await Promise.race([
          session.start({
            room: ctx.room,
            agent: model,
            record: recordingOptions?.enabled ?? false,
            // Let our disconnect / shutdown handler run cleanup (RecorderIO upload) before session closes
            inputOptions: { closeOnDisconnect: false },
          }),
          startupErrorPromise,
        ]);
        logger.info({ callId: call.id }, "session started");

        // Once startup has succeeded, we no longer need the startup-specific
        // error watcher; subsequent errors are treated as runtime failures.
        (startupErrorUnsubscribe as (() => void) | null)?.();
        operation = "connect";
        await ctx.connect();
        logger.info({ session }, "Connected to LiveKit");
      },
      15000,
      new Error("Call setup timeout (runAgentWorker)"),
      () =>
        logger.error(
          { ctx, operation },
          `info timeout during ${operation || "unknown"}`,
        ),
    );

    logger.debug({ room }, "connected got room");

    const flushDtmfBuffer = () => {
      if (dtmfBuffer.length > 0 && session) {
        const digitsToSend = dtmfBuffer;
        dtmfBuffer = ""; // Clear buffer before sending
        logger.debug(
          { digits: digitsToSend },
          "Flushing accumulated DTMF digits to LLM",
        );
        try {
          session.generateReply({ userInput: digitsToSend });
        } catch (e) {
          logger.error(
            { error: e, digits: digitsToSend },
            "Failed to inject DTMF digits via generate_reply",
          );
        }
      }
      if (dtmfTimeout) {
        clearTimeout(dtmfTimeout);
        dtmfTimeout = null;
      }
    };

    ctx.room.on(RoomEvent.DtmfReceived, async (code, digit, participant) => {
      logger.debug(
        {
          identity: participant.identity,
          code,
          digit,
          currentBuffer: dtmfBuffer,
        },
        "DTMF received from participant",
      );

      if (!session) {
        logger.warn("Session not available, cannot buffer DTMF digit");
        return;
      }

      // If terminator is pressed, send immediately (don't add terminator to buffer)
      if (digit === DTMF_TERMINATOR) {
        logger.debug(
          { buffer: dtmfBuffer },
          "DTMF terminator pressed, sending immediately",
        );
        flushDtmfBuffer();
        return;
      }

      // Add digit to buffer
      dtmfBuffer += digit;

      // Clear existing timeout and set a new one
      if (dtmfTimeout) {
        clearTimeout(dtmfTimeout);
      }

      // Set timeout to flush buffer after period of inactivity
      dtmfTimeout = setTimeout(() => {
        logger.debug(
          { buffer: dtmfBuffer },
          "DTMF timeout reached, flushing buffer",
        );
        flushDtmfBuffer();
      }, DTMF_TIMEOUT_MS);
    });
    logger.debug("DTMF listener registered");

    ctx.room.on(
      RoomEvent.ParticipantDisconnected,
      async (p: RemoteParticipant) => {
        const bp = getBridgedParticipant();
        logger.debug(
          { p, bridgedParticipant: bp, participant },
          "participant disconnected",
        );
        if (
          bp?.participantId === p?.info?.sid ||
          bp?.participantIdentity === p?.info?.identity
        ) {
          if (getConsultInProgress()) {
            logger.debug(
              "consult callee disconnected, treating as consult_reject",
            );
            // reset consult state
            // remove bridged participant if still present in server state (it should be gone already)
            try {
              bp?.participantIdentity &&
                (await roomService.removeParticipant(
                  room.name,
                  bp.participantId,
                ));
            } catch {}
            // underlying setters live in setup scope; remaining state will be reset on next transfer call
          } else {
            logger.debug("bridge participant disconnected, shutting down");
            // End transfer activity if in progress
            try {
              await endTransferActivityIfNeeded(
                DISCONNECT_REASONS.BRIDGED_PARTICIPANT,
              );
            } catch (transferError) {
              logger.error(
                { transferError },
                "error ending transfer activity during bridged participant disconnect",
              );
            }
            logger.debug(
              "transfer activity ended, closing AgentSession then cleanup",
            );
            suppressNextSessionCloseRoomHandlers = true;
            try {
              if (session) {
                try {
                  await session.close();
                } catch (closeErr) {
                  logger.warn(
                    { closeErr },
                    "session.close after bridge failed; continuing cleanup",
                  );
                }
                sessionRef(null);
                modelRef(null);
                session = null;
              }
            } finally {
              suppressNextSessionCloseRoomHandlers = false;
            }
            await cleanupAndClose(DISCONNECT_REASONS.BRIDGED_PARTICIPANT);
            logger.debug("cleanup and close done");

            setBridgedParticipant(null as unknown as SipParticipant);
          }
        } else if (p.info?.sid === participant?.sid) {
          logger.debug(
            "participant disconnected, initiating graceful shutdown",
          );
          // End transfer activity if in progress
          try {
            await endTransferActivityIfNeeded(
              DISCONNECT_REASONS.ORIGINAL_PARTICIPANT,
            );
          } catch (transferError) {
            logger.error(
              { transferError },
              "error ending transfer activity during original participant disconnect",
            );
          }

          // Let the AgentSession finish and close; when the job shuts down,
          // our shutdown callback will finalize and upload the RecorderIO file.
          if (session) {
            try {
              await session.close();
            } catch (e) {
              logger.warn(
                { e },
                "error closing session after participant disconnect, falling back to hard cleanup",
              );
              await cleanupAndClose(
                DISCONNECT_REASONS.ORIGINAL_PARTICIPANT,
                true,
              );
            }
          } else {
            await cleanupAndClose(
              DISCONNECT_REASONS.ORIGINAL_PARTICIPANT,
              true,
            );
          }
        }
      },
    );

    // Hard stop timeout on the session which is 5 seconds after the AI agent maxDuration
    // This is to ensure that the session is closed and the room is deleted even if the
    // AI agent fails to close the session (e.g OpenAI has no maxDuration parameter)
    timerId = setTimeout(
      () => {
        // If the bridged participant is present, we have transferred out, ignore the session timeout.
        if (getBridgedParticipant()) {
          logger.debug("bridged participant present, ignoring session timeout");
          return;
        }
        logger.debug("session timeout, generating reply");
        try {
          session?.generateReply({ userInput: "The session has timed out." });
        } catch (e) {
          logger.info({ e }, "error generating timeout reply");
        }
        // 10 secs later, tear everything down
        setTimeout(async () => {
          try {
            // End transfer activity if in progress
            try {
              await endTransferActivityIfNeeded(
                DISCONNECT_REASONS.SESSION_TIMEOUT,
              );
            } catch (transferError) {
              logger.error(
                { transferError },
                "error ending transfer activity during session timeout",
              );
            }
            cleanupAndClose(DISCONNECT_REASONS.SESSION_TIMEOUT);
          } catch (e) {
            logger.info({ e }, "error tearing down call on timeout");
          }
        }, 10 * 1000);
      },
      maxDuration + 5 * 1000,
    );

    logger.debug("session started, generating reply");

    sendMessage({ call: `${callerId} => ${calledId}` });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error(
      { error, message: error.message, stack: error.stack },
      "error running agent worker",
    );

    // If the call has not yet started, treat this as a setup failure and let the
    // caller decide whether to invoke fallback behaviour. We deliberately do NOT
    // clean up the call/room here so that the outer loop can retry with a different
    // model/agent on the same LiveKit room.
    if (!callStarted) {
      throw error;
    }

    await cleanupAndClose(DISCONNECT_REASONS.UNCAUGHT_ERROR_RUNNING_AGENT);
  }
}
