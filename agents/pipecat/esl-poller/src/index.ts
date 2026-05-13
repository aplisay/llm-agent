import dotenv from "dotenv";
import './google-secret-helper.js';
import pino from "pino";
import axios from "axios";
import { FreeSwitchClient, type FreeSwitchEventData } from "esl-lite";
import { startCallApi } from "./call-api.js";

export type RegistrationState = "initial" | "registering" | "registered" | "failed";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOGLEVEL || "info",
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
      }),
});

const ESL_HOST = process.env.ESL_HOST || "freeswitch";
const ESL_PORT = Number(process.env.ESL_PORT || 8021);
const ESL_SECRET = process.env.ESL_SECRET || "ClueCon";
const ESL_TIMEOUT = Number(process.env.ESL_TIMEOUT || 5000);
const CONFIG_SERVER_BASE =
  process.env.CONFIG_SERVER_BASE || "http://config-server:4000";
const CONFIG_SERVER_TOKEN =
  process.env.CONFIG_SERVER_TOKEN || process.env.FS_CONFIG_TOKEN || "";
// Gateway polling is the original aplisay-b2bua behaviour. In the Pipecat
// stack we don't run a config-server, so the poller is opt-in (set
// GATEWAY_POLL_ENABLED=true to re-enable when the binary is reused with
// aplisay-b2bua's config-server).
const POLL_ENABLED = (process.env.GATEWAY_POLL_ENABLED ?? "false").toLowerCase() === "true";
// Call-control API is always on — it's the surface the Pipecat worker uses.
const CALL_API_ENABLED = (process.env.CALL_API_ENABLED ?? "true").toLowerCase() === "true";

// Cache of last known states
const lastStateByGateway: Map<string, RegistrationState> = new Map();

// Track failed state counter for each gateway
// Counter increments each time we see a failed state during reconciliation
// Resets to 0 when we see an up/registered state
// When counter reaches 7, we mark the gateway as failed in the database
const failedStateCounterByGateway: Map<string, number> = new Map();

export function mapFsStateToRegistration(fsState: string): RegistrationState {
  const s = (fsState || "").toUpperCase();
  logger.info(
    { fsState, s },
    "Mapping FreeSWITCH state to registration state"
  );
  switch (s) {
    case "REGED":
    case "UP":
    case "ALIVE":
      return "registered";
    case "TRYING":
    case "PROBING":
    case "REGISTER":
      return "registering";
    case "NOREG":
    case "UNREGED":
    case "FAILED":
    case "DOWN":
    case "EXPIRED":
    case "FAIL_WAIT":
      return "failed";
    default:
      return "initial";
  }
}

export async function postGatewayState(
  gatewayId: string,
  state: RegistrationState
): Promise<void> {
  try {
    await axios.post(
      `${CONFIG_SERVER_BASE}/admin/gateways/${encodeURIComponent(
        gatewayId
      )}/status`,
      { state },
      {
        headers: CONFIG_SERVER_TOKEN
          ? { Authorization: `Bearer ${CONFIG_SERVER_TOKEN}` }
          : undefined,
        timeout: 5000,
      }
    );
    logger.debug({ gatewayId, state }, "Posted gateway state");
  } catch (err) {
    logger.warn({ err, gatewayId, state }, "Failed to post gateway state");
  }
}

export async function markGatewayAsFailed(gatewayId: string): Promise<void> {
  try {
    await axios.post(
      `${CONFIG_SERVER_BASE}/admin/gateways/${encodeURIComponent(
        gatewayId
      )}/mark-failed`,
      {},
      {
        headers: CONFIG_SERVER_TOKEN
          ? { Authorization: `Bearer ${CONFIG_SERVER_TOKEN}` }
          : undefined,
        timeout: 5000,
      }
    );
    logger.info({ gatewayId }, "Marked gateway as failed in database");
  } catch (err) {
    logger.warn({ err, gatewayId }, "Failed to mark gateway as failed");
  }
}

/**
 * Parse "sofia status gateway" output and extract external gateway IDs with their states.
 * Filters out livekit gateways, header lines, separators, and strips "external::" prefix.
 * Only returns gateways from the external profile.
 *
 * @param output Raw output from FreeSwitch "sofia status gateway" command
 * @returns Map of gateway ID (without "external::" prefix) to registration state
 */
export function parseSofiaStatusGateway(
  output: string
): Map<string, RegistrationState> {
  const result: Map<string, RegistrationState> = new Map();
  logger.debug({ output }, "Parsing Sofia status gateway output");

  if (!output) return result;

  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Track header-derived column index for the State column when present
  let stateColumnIndexFromHeader: number | undefined;

  for (const line of lines) {
    // Skip header lines, separator lines, and empty lines
    // Header line contains: "Name", "Type", "Data", "State" all together
    const isHeaderLine =
      ((line.includes("Name") && line.includes("Type") && line.includes("Data") && line.includes("State")) ||
        // Newer header variant: Profile::Gateway-Name  Data  State  Ping Time  IB Calls(F/T)  OB Calls(F/T)
        (line.includes("Profile::Gateway-Name") && line.includes("State")));
    
    // Separator lines are only dashes, equals signs, or spaces
    const isSeparatorLine = line.match(/^[=\-\s]+$/) !== null;
    
    if (!line || line.length === 0) continue;

    // If header, compute the column index for the State column and continue
    if (isHeaderLine) {
      const headerCols = line.split(/\s+/).filter((col) => col.length > 0);
      const idx = headerCols.findIndex((c) => c.toLowerCase() === "state");
      if (idx >= 0) stateColumnIndexFromHeader = idx;
      continue;
    }
    if (isSeparatorLine) continue;

    // Split on whitespace - format is typically: name sofia gateway state
    const cols = line.split(/\s+/).filter((col) => col.length > 0);

    // Need at least 3 columns: gateway name, data, state
    if (cols.length < 3) {
      continue;
    }

    let gatewayId = cols[0];
    // Determine state column
    let fsState: string | undefined;
    if (stateColumnIndexFromHeader !== undefined && cols.length > stateColumnIndexFromHeader) {
      // Use header-derived column index
      fsState = cols[stateColumnIndexFromHeader];
    } else {
      // Heuristics fallback
      // Classic format: "external::gateway1 sofia gateway REGED"
      if (
        cols.length >= 4 &&
        cols[1].toLowerCase() === "sofia" &&
        cols[2].toLowerCase() === "gateway"
      ) {
        fsState = cols[3];
      } else if (cols.length >= 3) {
        // Alternative format: gateway, data, state
        fsState = cols[2];
      } else {
        fsState = cols[cols.length - 1];
      }
    }

    // Only process external profile gateways (strip "external::" prefix if present)
    // Skip any non-external gateways (e.g., livekit or internal gateways)
    if (!gatewayId.startsWith("external::")) {
      // If it doesn't have external:: prefix, it might be a livekit or other profile gateway
      // Skip those entirely
      continue;
    }

    // Strip "external::" prefix
    gatewayId = gatewayId.substring("external::".length);

    // Validate gateway ID and state
    if (
      gatewayId &&
      gatewayId.length > 0 &&
      fsState &&
      gatewayId !== "livekit" &&
      !gatewayId.toLowerCase().includes("livekit") &&
      !gatewayId.match(/^[=\-]+$/) // Not a separator line
    ) {
      result.set(gatewayId, mapFsStateToRegistration(fsState));
    }
  }

  logger.debug(
    {
      gatewayCount: result.size,
      gateways: Array.from(result.entries()).map(([id, state]) => ({
        id,
        state,
      })),
    },
    "Parsed external gateways from sofia status"
  );

  return result;
}

async function initialGatewayStatusPoll(
  client: FreeSwitchClient
): Promise<void> {
  try {
    const res = await client.bgapi("sofia status gateway", ESL_TIMEOUT);
    if ("body" in res) {
      const { response } = res.body;
      logger.debug({ response }, "Initial gateway status poll response");
      const current = parseSofiaStatusGateway(response as string);
      for (const [gatewayId, state] of current.entries()) {
        lastStateByGateway.set(gatewayId, state);
        void postGatewayState(gatewayId, state);
      }
      logger.info(
        { gatewayCount: current.size },
        "Initial gateway status poll completed"
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to run initial gateway status poll");
  }
}

/**
 * Fetch active gateway IDs from config server
 */
export async function fetchActiveGatewayIds(): Promise<Set<string>> {
  try {
    const response = await axios.get(
      `${CONFIG_SERVER_BASE}/admin/gateways/ids`,
      {
        headers: CONFIG_SERVER_TOKEN
          ? { Authorization: `Bearer ${CONFIG_SERVER_TOKEN}` }
          : undefined,
        timeout: 5000,
      }
    );
    const ids = response.data?.ids || [];
    logger.debug(
      { ids, count: ids.length },
      "Fetched active gateway IDs from config server"
    );
    return new Set(ids);
  } catch (err) {
    logger.warn(
      { err },
      "Failed to fetch active gateway IDs from config server"
    );
    return new Set();
  }
}

/**
 * Reconcile FreeSwitch gateways with config server cache.
 * Removes gateways that are in FreeSwitch but not in config server.
 * Tracks failed state counters and marks gateways as failed after 7 consecutive failed states.
 */
// Export a test helper to reset the failed counter (for testing)
export function resetFailedStateCounter(): void {
  failedStateCounterByGateway.clear();
}

export async function reconcileGateways(client: FreeSwitchClient): Promise<void> {
  try {
    logger.info(
      {
        failedCounterSize: failedStateCounterByGateway.size,
        failedCounters:
          failedStateCounterByGateway.size > 0
            ? Array.from(failedStateCounterByGateway.entries()).map(
                ([gatewayId, count]) => ({ gatewayId, count })
              )
            : [],
      },
      "Starting gateway reconciliation"
    );

    // Fetch active gateway IDs from config server
    const activeGatewayIds = await fetchActiveGatewayIds();
    logger.debug(
      {
        activeGatewayIds: Array.from(activeGatewayIds),
        count: activeGatewayIds.size,
      },
      "Active gateway IDs from config server"
    );

    // Get current gateways from FreeSwitch
    const res = await client.bgapi("sofia status gateway", ESL_TIMEOUT);
    if (!("body" in res) || !res.body?.response) {
      logger.warn("No response from sofia status gateway command");
      return;
    }

    const output = res.body.response as string;
    const fsGateways = parseSofiaStatusGateway(output);
    const fsGatewayIds = new Set(fsGateways.keys());

    // Log the current FreeSWITCH view and current failed counters before updates
    logger.info(
      {
        fsGatewayCount: fsGatewayIds.size,
        fsGateways: Array.from(fsGateways.entries()).map(([id, state]) => ({
          id,
          state,
        })),
        failedCounterSizeBefore: failedStateCounterByGateway.size,
        failedCountersBefore:
          failedStateCounterByGateway.size > 0
            ? Array.from(failedStateCounterByGateway.entries()).map(
                ([gatewayId, count]) => ({ gatewayId, count })
              )
            : [],
      },
      "Reconciliation snapshot before applying updates"
    );

    // Track failed state counters for gateways in FreeSwitch
    for (const [gatewayId, state] of fsGateways.entries()) {
      // Only track gateways that are in the config server (active gateways)
      if (activeGatewayIds.has(gatewayId)) {
        if (state === "failed") {
          // Increment failed state counter
          const currentCount = failedStateCounterByGateway.get(gatewayId) || 0;
          const newCount = currentCount + 1;
          failedStateCounterByGateway.set(gatewayId, newCount);
          
          logger.debug(
            { gatewayId, failedCount: newCount },
            "Incremented failed state counter for gateway"
          );

          // If counter reaches 7 (more than 30 mins with 5-minute reconciliation interval)
          if (newCount >= 7) {
            logger.warn(
              { gatewayId, failedCount: newCount },
              "Gateway has been in failed state for 7+ reconciliation cycles, marking as failed"
            );
            // Mark gateway as failed in database
            await markGatewayAsFailed(gatewayId);
            // Reset counter after marking as failed (it will be excluded from active gateways now)
            failedStateCounterByGateway.delete(gatewayId);
          }
        } else if (state === "registered") {
          // Reset counter only when registration succeeds
          if (failedStateCounterByGateway.has(gatewayId)) {
            logger.debug(
              { gatewayId, previousCount: failedStateCounterByGateway.get(gatewayId) },
              "Resetting failed state counter for gateway (registration succeeded)"
            );
            failedStateCounterByGateway.delete(gatewayId);
          }
        }
      }
    }

    // Find gateways in FreeSwitch that are not in config server
    const gatewaysToRemove: string[] = [];
    for (const gatewayId of fsGatewayIds) {
      if (!activeGatewayIds.has(gatewayId)) {
        gatewaysToRemove.push(gatewayId);
        // Clean up failed state counter if gateway is being removed
        failedStateCounterByGateway.delete(gatewayId);
      }
    }

    if (gatewaysToRemove.length === 0) {
      logger.info(
        {
          fsCount: fsGatewayIds.size,
          activeCount: activeGatewayIds.size,
          failedCounterSizeAfter: failedStateCounterByGateway.size,
          failedCountersAfter:
            failedStateCounterByGateway.size > 0
              ? Array.from(failedStateCounterByGateway.entries()).map(
                  ([gatewayId, count]) => ({ gatewayId, count })
                )
              : [],
        },
        "Gateway reconciliation: no gateways to remove"
      );
      return;
    }

    logger.info(
      { gatewaysToRemove, count: gatewaysToRemove.length },
      "Found gateways to remove from FreeSwitch"
    );

    // Issue killgw command for each gateway to remove
    for (const gatewayId of gatewaysToRemove) {
      try {
        const killRes = await client.bgapi(
          `sofia profile external killgw ${gatewayId}`,
          ESL_TIMEOUT
        );
        logger.info(
          { gatewayId, killRes },
          "Issued killgw command for gateway"
        );
      } catch (err) {
        logger.warn(
          { err, gatewayId },
          "Failed to issue killgw command for gateway"
        );
      }
    }

    logger.info(
      {
        removedCount: gatewaysToRemove.length,
        failedCounterSizeAfter: failedStateCounterByGateway.size,
        failedCountersAfter:
          failedStateCounterByGateway.size > 0
            ? Array.from(failedStateCounterByGateway.entries()).map(
                ([gatewayId, count]) => ({ gatewayId, count })
              )
            : [],
      },
      "Gateway reconciliation completed"
    );
  } catch (err) {
    logger.warn({ err }, "Failed to reconcile gateways");
  }
}

async function start(): Promise<void> {
  if (!POLL_ENABLED && !CALL_API_ENABLED) {
    logger.warn("Both gateway polling and call API are disabled — nothing to do");
    return;
  }

  logger.info(
    { ESL_HOST, ESL_PORT, password: ESL_SECRET ? "********" : undefined },
    "Connecting to FreeSWITCH ESL"
  );
  const client = new FreeSwitchClient({
    host: ESL_HOST,
    port: ESL_PORT,
    password: ESL_SECRET,
    logger,
  });

  // Call-control HTTP API for the Pipecat worker. Always-on by default;
  // wires CHANNEL_HANGUP / CHANNEL_BRIDGE / CHANNEL_ANSWER forwarding to the
  // worker's webhook in addition to the originate/transfer/hangup routes.
  if (CALL_API_ENABLED) {
    startCallApi({ client, logger });
  }

  // The gateway-state poller is the original aplisay-b2bua behaviour and is
  // only used when GATEWAY_POLL_ENABLED=true (reusing this binary with the
  // aplisay-b2bua config-server). The Pipecat stack does not enable it.
  if (!POLL_ENABLED) {
    logger.info("gateway-state poller disabled (GATEWAY_POLL_ENABLED=false)");
    return;
  }

  // Set up gateway state event handler
  client.custom.on("sofia::gateway_state", (msg: any) => {
    try {
      const gatewayName =
        msg.body?.data?.Gateway || msg.body?.headers?.["Gateway-Name"];
      const state = msg.body?.data?.State || msg.body?.headers?.["State"];
      logger.debug({ gatewayName, state }, "Gateway state event");
      if (gatewayName && state) {
        const registrationState = mapFsStateToRegistration(state);
        const prev = lastStateByGateway.get(gatewayName);
        if (prev !== registrationState) {
          lastStateByGateway.set(gatewayName, registrationState);
          void postGatewayState(gatewayName, registrationState);
        }
      }
    } catch (err) {
      logger.warn({ err, msg }, "Error handling gateway state event");
    }
  });

  try {
    // Do initial gateway status poll
    await initialGatewayStatusPoll(client);

    // Set up periodic rescan (once per minute)
    let lastMinuteRan = -1;
    setInterval(async () => {
      const now = new Date();
      const minute = now.getUTCMinutes();
      if (minute !== lastMinuteRan) {
        lastMinuteRan = minute;
        try {
          await client.bgapi("sofia profile external rescan", ESL_TIMEOUT);
          await client.bgapi("sofia profile livekit rescan", ESL_TIMEOUT);
        } catch (err) {
          logger.warn({ err }, "Failed to run sofia gateway rescan");
        }
      }
    }, 60000);

    // Set up periodic gateway reconciliation (every 5 minutes)
    setInterval(async () => {
      try {
        await reconcileGateways(client);
      } catch (err) {
        logger.warn({ err }, "Gateway reconciliation interval failed");
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Run initial reconciliation after a short delay to allow initial setup
    setTimeout(async () => {
      try {
        await reconcileGateways(client);
      } catch (err) {
        logger.warn({ err }, "Initial gateway reconciliation failed");
      }
    }, 30000); // 30 seconds after startup
  } catch (err) {
    logger.error({ err }, "Failed to start ESL poller");
    process.exit(1);
  }
}

// Start whenever at least one of the two surfaces is enabled.
if (!process.env.JEST_WORKER_ID && (POLL_ENABLED || CALL_API_ENABLED)) {
  start().catch((err) => {
    logger.error({ err }, "Fatal error");
    process.exit(1);
  });
}
