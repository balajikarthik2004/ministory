import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendSuccess } from '../../utils/response.js';
import { optionalCallerOf } from '../../middleware/identity.js';
import * as service from './playback.service.js';

/**
 * Ingestion is deliberately tolerant of an anonymous caller.
 *
 * A guest watching free episodes produces telemetry that is still worth
 * having — the events land with a null userId. Requiring authentication here
 * would silently discard every guest session, which is most of the funnel
 * this data exists to measure.
 */

/**
 * The outer envelope only. Individual events are validated inside the
 * service, one at a time, so a single malformed event cannot fail a batch
 * that is otherwise fine.
 */
const batchEnvelopeSchema = z.object({
  events: z.array(z.unknown()).min(1),
});

export async function handleIngestEvents(req: Request, res: Response): Promise<void> {
  const { events } = batchEnvelopeSchema.parse(req.body);
  const caller = optionalCallerOf(req);

  const result = await service.ingestEvents(events, caller?.userId ?? null, req.requestId);

  // 202: the events are stored, but the rollups that read them are not
  // updated synchronously (ARCH §8).
  sendSuccess(res, { acceptedEventIds: result.acceptedEventIds }, 202);
}
