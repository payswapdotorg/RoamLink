export const SLO_DEMO = makeServiceLevelObjective({
  name: "slo.time-to-usable-connectivity",
  targetRatio: 0.95,
  windowMs: 60000,
});

function makeServiceLevelObjective(options: Record<string, unknown>): Record<string, unknown> {
  return { ...options };
}
