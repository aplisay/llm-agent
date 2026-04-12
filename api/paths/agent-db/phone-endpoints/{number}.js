import { updatePhoneEndpointProvisioning } from '../phone-endpoints.js';

export default function (logger, voices, wsServer) {
  return {
    PATCH: updatePhoneEndpointProvisioning
  };
}

