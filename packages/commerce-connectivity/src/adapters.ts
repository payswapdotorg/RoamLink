/**
 * Production bindings for the reference-model ports (RL-023).
 *
 *  - `projectionReaderAsEvidenceSource`: adapts the ADCOS projection
 *    engine's READ surface (RL-034 `ProjectionReader`) to the
 *    {@link DeliveryEvidenceSource} port. This is the ONLY file in the
 *    package that touches @roamlink/projections, and it touches only the
 *    read surface - the write surface belongs to the integration boundary
 *    alone (spec §8, RL-LOCK-002).
 *
 *  - `commerceReadViewsAsSubjectReader`: adapts domain-commerce's
 *    committed read views (orders + subscriptions) to the
 *    {@link CommercialSubjectReader} port. Read-only: the reference model
 *    never writes commerce state.
 */
import type { ProjectionReader } from "@roamlink/projections";
import type { CommerceReadViews } from "@roamlink/domain-commerce";
import type { TenantId } from "@roamlink/contracts";

import type {
  CommercialSubjectReader,
  CommercialSubjectFacts,
} from "./ports.js";
import type { DeliveryEvidenceSource } from "./evidence-source.js";

/**
 * Binds a projection READ surface as the delivery-evidence source. The
 * §8 record shape satisfies the observation port structurally - TypeScript
 * itself proves the field compatibility here (provenance, freshness and
 * digests cannot be dropped in translation, RL-LOCK-010).
 */
export function projectionReaderAsEvidenceSource(reader: ProjectionReader): DeliveryEvidenceSource {
  return {
    async get(canonicalResourceType, canonicalResourceId) {
      const record = await reader.get(
        // The closed §8 resource vocabulary is shared; the cast is safe
        // because the vocabularies are pinned equal by conformance tests.
        canonicalResourceType as Parameters<ProjectionReader["get"]>[0],
        canonicalResourceId,
      );
      return record;
    },
  };
}

/** Binds domain-commerce committed read views as the subject reader. */
export function commerceReadViewsAsSubjectReader(views: CommerceReadViews): CommercialSubjectReader {
  return {
    async findOrder(tenantId: TenantId, orderId: string): Promise<CommercialSubjectFacts | undefined> {
      const order = await views.orders.findById(tenantId, orderId as Parameters<
        CommerceReadViews["orders"]["findById"]
      >[1]);
      if (order === undefined) return undefined;
      return Object.freeze({
        subjectType: "order",
        subjectId: order.orderId,
        commercialState: order.status,
      });
    },
    async findSubscription(
      tenantId: TenantId,
      subscriptionId: string,
    ): Promise<CommercialSubjectFacts | undefined> {
      const subscription = await views.subscriptions.findById(
        tenantId,
        subscriptionId as Parameters<CommerceReadViews["subscriptions"]["findById"]>[1],
      );
      if (subscription === undefined) return undefined;
      return Object.freeze({
        subjectType: "subscription",
        subjectId: subscription.subscriptionId,
        commercialState: subscription.status,
      });
    },
  };
}
