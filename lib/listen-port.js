/**
 * The port the API server listens on. WS_PORT wins so that existing deploys
 * keep their port; PORT is what Cloud Run and most container platforms set.
 */
export function listenPort(env = process.env) {
  return env.WS_PORT || env.PORT || 4000;
}
