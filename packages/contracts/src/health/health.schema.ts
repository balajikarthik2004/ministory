import { z } from 'zod';

/**
 * Health and readiness payloads. See docs/API_DOCUMENTATION.md §10.
 *
 * /health  - liveness: the process is running.
 * /ready   - readiness: dependencies are reachable. Dependency checks are
 *            added as those dependencies arrive (database in M1.3).
 */

export const healthStatusSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string(),
  version: z.string(),
  environment: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const dependencyCheckSchema = z.object({
  name: z.string(),
  status: healthStatusSchema,
  latencyMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readinessResponseSchema = healthResponseSchema.extend({
  dependencies: z.array(dependencyCheckSchema),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
