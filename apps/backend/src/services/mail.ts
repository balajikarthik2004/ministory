import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { env, isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Outbound mail, behind a provider interface.
 *
 * THE FREE-FIRST POSITION (CLAUDE.md §18, approved for M2.5): every free
 * transactional mail service requires creating an account with an external
 * provider, which this milestone does not do. So the development provider
 * writes each message to a file, and password reset and email verification
 * are built, wired and tested end to end against it. You read the link out of
 * `.mail-outbox/` instead of an inbox.
 *
 * THIS IS A TEMPORARY IMPLEMENTATION AND IS LABELLED AS ONE (CLAUDE.md §16.12).
 *
 * A file-based provider in production would mean a password reset that
 * reports success and silently writes to a directory on the server. The
 * viewer waits for a link that was never sent, and the only symptom is a
 * support ticket. So `isMailDeliveryAvailable()` is false there, and the
 * endpoints that depend on delivery refuse with 503 rather than lying.
 *
 * THE REFUSAL IS SCOPED TO THOSE ENDPOINTS, NOT TO THE PROCESS. The catalogue,
 * the player and watch history do not send mail and have no reason to be
 * unavailable because password recovery is unconfigured.
 *
 * Adding real delivery means writing one more class here and one more value
 * in the `MAIL_PROVIDER` enum. No flow that sends mail changes.
 */

/**
 * Whether mail will actually reach a person.
 *
 * False in production with the file provider — the one combination where a
 * send succeeds and the message goes nowhere. True in development, where
 * reading `.mail-outbox/` is the approved delivery method for this milestone.
 */
export function isMailDeliveryAvailable(): boolean {
  return !(isProduction && env.MAIL_PROVIDER === 'file');
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. No HTML until there is a real sender to render it. */
  body: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

/**
 * Writes each message to a file in `MAIL_OUTBOX_DIR`. Development only.
 *
 * WHAT IS LOGGED, AND WHAT IS NOT: the log line carries the recipient, the
 * subject and the filename. It does NOT carry the body, because the body is
 * where the reset token is, and a token in a log file is a token in whatever
 * the logs are shipped to (CLAUDE.md §11, M2.5 Phase 2 — "never log passwords,
 * tokens or reset secrets"). The filename is how a developer finds the link.
 */
export class FileMailProvider implements MailProvider {
  readonly name = 'file (development only — writes to disk, sends nothing)';

  constructor(private readonly directory: string) {}

  async send(message: MailMessage): Promise<void> {
    const dir = resolve(process.cwd(), this.directory);
    await mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${stamp}-${randomUUID().slice(0, 8)}.txt`;

    const contents = [
      `From: ${env.MAIL_FROM}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      `Date: ${new Date().toUTCString()}`,
      '',
      message.body,
      '',
    ].join('\n');

    await writeFile(resolve(dir, filename), contents, 'utf8');

    logger.info(
      { to: message.to, subject: message.subject, file: filename },
      'Mail written to the development outbox (not sent)',
    );
  }
}

/**
 * Discards every message.
 *
 * For the test suite, which must assert that a flow *tried* to send without
 * leaving a thousand files behind. It records the last message so a test can
 * read the token it would have emailed — which is the only way to test the
 * reset flow end to end without reading the database directly and thereby
 * testing something other than what the user does.
 */
export class MemoryMailProvider implements MailProvider {
  readonly name = 'memory (tests)';
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === email);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

// ─────────────────────────── Provider registry ───────────────────────────
//
// Same shape as the identity registry in services/identity.ts, for the same
// reason: one place decides which implementation is live, and no caller
// branches on it.

let provider: MailProvider = new FileMailProvider(env.MAIL_OUTBOX_DIR);

export function setMailProvider(next: MailProvider): void {
  provider = next;
  logger.info({ provider: next.name }, 'Mail provider registered');
}

export function getMailProvider(): MailProvider {
  return provider;
}

/**
 * Sends, and never lets a delivery failure fail the request.
 *
 * WHY A FAILURE IS SWALLOWED HERE. The caller is `forgot-password` or
 * `register`, both of which must answer identically regardless of what
 * happened — including whether the address was deliverable. Propagating a
 * send error would produce a 500 for a real address and a 200 for one that
 * does not exist, which is the enumeration leak those endpoints exist to
 * avoid. The failure is logged; the response is not changed.
 */
export async function sendMailSafely(message: MailMessage): Promise<void> {
  try {
    await getMailProvider().send(message);
  } catch (error) {
    logger.error(
      { err: error, to: message.to, subject: message.subject },
      'Mail delivery failed; the request was answered normally',
    );
  }
}
