/**
 * The host-side ops surface session layer (RL-109).
 *
 * The ops SLO dashboard is an ADMIN-CLASS surface: the fail-closed
 * rendering gate mirrors apps/admin's discipline exactly — resolve the
 * actor's session BEFORE any surface state is read, require the operator
 * read permission (`org:read`, the same permission the console's operator
 * surfaces map to), and render an access-denied panel (never the surface,
 * never partial data) when the actor lacks it. A session that cannot be
 * resolved surfaces to the caller so the handler re-authenticates.
 *
 * The session resolution is a REAL /v1/users/me through the API service
 * (the same principal read every host surface performs); the parsed
 * ActorSessionResource is the app-kit contract shape the console's gate
 * parses. No parallel authority: the API's answer IS the gate's answer.
 */
import {
  parseActorSessionResource,
  type ActorSessionResource,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import type { ApiService } from "@roamlink/api-service";

import { SessionResolutionError } from "./surface.js";

/**
 * Resolves the authenticated principal behind `token` into the full
 * ActorSessionResource (permissions included) through a REAL API read.
 * Any failure (unknown/expired/revoked token, malformed view) raises the
 * typed {@link SessionResolutionError}.
 */
export async function resolveActorSession(
  api: Pick<ApiService, "handle">,
  token: string,
): Promise<ActorSessionResource> {
  const principalRequest: HttpRequest = {
    method: "GET",
    path: "/v1/users/me",
    headers: { authorization: `Bearer ${token}` },
  };
  let response: HttpResponse;
  try {
    response = await api.handle(principalRequest);
  } catch {
    throw new SessionResolutionError("the session could not be resolved (the principal read failed)");
  }
  if (response.status !== 200 || response.body === undefined) {
    throw new SessionResolutionError(`the presented session was rejected (${response.status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new SessionResolutionError("the principal view was not the contracted session resource");
  }
  try {
    return parseActorSessionResource(parsed);
  } catch {
    throw new SessionResolutionError("the principal view was not the contracted session resource");
  }
}
