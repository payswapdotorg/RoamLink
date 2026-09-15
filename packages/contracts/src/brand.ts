/**
 * Nominal branding machinery for RoamLink contract primitives.
 *
 * Branding gives compile-time nominal typing over structural runtime values
 * (strings / numbers) so that e.g. a {@link ./ids/foreign-refs.js.AdcosIntentRef}
 * can never be accidentally passed where a RoamLink
 * {@link ./ids/roamlink-ids.js.UserId} is expected (RL-LOCK-003: no duplicate
 * identity authority; foreign canonical IDs are explicitly separate types).
 *
 * Brands are erased at runtime - a branded value IS its underlying primitive.
 */
declare const roamlinkBrandTag: unique symbol;

/**
 * A branded string. `Tag` is the nominal type name, e.g. `Branded<"UserId">`.
 */
export type Branded<Tag extends string> = string & {
  readonly [roamlinkBrandTag]: Tag;
};

/**
 * A branded integer used for monotonic revisions / optimistic concurrency.
 */
declare const roamlinkRevisionTag: unique symbol;

export type BrandedRevision = number & {
  readonly [roamlinkRevisionTag]: "Revision";
};
