import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response.js';
import * as healthService from './health.service.js';

/** Controllers do HTTP in and HTTP out. No business rules live here. */

export function handleHealth(_req: Request, res: Response): void {
  sendSuccess(res, healthService.getHealth());
}

export async function handleReadiness(_req: Request, res: Response): Promise<void> {
  const readiness = await healthService.getReadiness();
  // A not-ready instance must say so with a status code a load balancer reads.
  sendSuccess(res, readiness, readiness.status === 'ok' ? 200 : 503);
}
