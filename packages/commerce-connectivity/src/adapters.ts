/**
 * Production binding for the commercial-subject port (RL-023).
 *
 * `commerceReadViewsAsSubjectReader`: adapts domain-commerce's committed
 * read views (orders + subscriptions) to the {@link CommercialSubjectReader}
 * port. Read-only: the reference model never writes commerce state.
 *
 * NOTE ON THE EVIDENCE SOURCE: the {@link DeliveryEvidenceSource} port is
 * DELIBERATELY unbound in this package. The projection read surface is
 * owned by the integration boundary (spec §8: only the reconciler /
 * integration boundary writes ADCOS-derived projections, and its factory
 * exposes a get/list/count-only reader) - so the binding from that exposed
 * reader to this port belongs to the COMPOSITION layer (services/, Wave 4),
 * never to a domain package. This keeps the dependency direction clean and
 * the projection boundary intact (RL-LOCK-002/019; the reconciliation
 * boundary-enforcement test proves no package outside {projections,
 * reconciliation} imports the projection package at all).
 */
import type { CommerceReadViews } from "@roamlink/domain-commerce";
import type { TenantId } from "@roamlink/contracts";

import type { CommercialSubjectFacts, CommercialSubjectReader } from "./ports.js";

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
