import { env } from '../../config/env.js';
import { sendMailSafely } from '../../services/mail.js';

/**
 * The messages the authentication flows send.
 *
 * Kept apart from the service so that the copy can be read and changed
 * without reading the security logic, and so that the service's flow is not
 * interrupted by three paragraphs of prose per branch.
 *
 * EVERY FUNCTION HERE IS FIRE-AND-FORGET (`sendMailSafely`). A delivery
 * failure is logged and the request still answers normally — see the note on
 * `sendMailSafely` for why a thrown send error would reintroduce the
 * enumeration leak these flows are shaped to avoid.
 */

function link(path: string, token: string): string {
  const base = env.AUTH_LINK_BASE_URL.replace(/\/+$/, '');
  return `${base}/${path}?token=${encodeURIComponent(token)}`;
}

function minutesOrHours(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  await sendMailSafely({
    to,
    subject: 'Reset your MiniDrama password',
    body: [
      'Someone asked to reset the password for this MiniDrama account.',
      '',
      'Open this link to choose a new one:',
      link('reset-password', token),
      '',
      `The link works once and expires in ${minutesOrHours(env.AUTH_RESET_TTL_MIN)}.`,
      '',
      'If this was not you, nothing has changed and you can ignore this message.',
      'Your password stays as it is until the link above is used.',
    ].join('\n'),
  });
}

/**
 * Sent when someone tries to register with an address that already has an
 * account.
 *
 * THIS MESSAGE IS WHAT MAKES ENUMERATION-SAFE REGISTRATION HONEST. The API
 * answers the duplicate attempt exactly as it answers a successful one, so
 * the person at the keyboard learns nothing — but the real owner of the
 * address does need to know, both because it may be them having forgotten,
 * and because it may be someone probing their account.
 */
export async function sendAccountExistsEmail(to: string): Promise<void> {
  await sendMailSafely({
    to,
    subject: 'Someone tried to sign up with your MiniDrama address',
    body: [
      'Someone tried to create a MiniDrama account with this email address,',
      'but an account already exists for it.',
      '',
      'If that was you: sign in instead. If you have forgotten your password,',
      'use "Forgot password" on the sign-in screen.',
      '',
      'If it was not you, no action is needed. No account was created and',
      'nothing about your existing account has changed.',
    ].join('\n'),
  });
}

export async function sendEmailVerification(to: string, token: string): Promise<void> {
  await sendMailSafely({
    to,
    subject: 'Confirm your MiniDrama email address',
    body: [
      'Welcome to MiniDrama.',
      '',
      'Confirm this email address so you can recover your account if you',
      'ever lose your password:',
      link('verify-email', token),
      '',
      `The link works once and expires in ${minutesOrHours(env.AUTH_VERIFY_TTL_HOURS * 60)}.`,
      '',
      'You can keep watching in the meantime — confirming is not required',
      'to use the app.',
    ].join('\n'),
  });
}

export async function sendPasswordChangedEmail(to: string): Promise<void> {
  await sendMailSafely({
    to,
    subject: 'Your MiniDrama password was changed',
    body: [
      'The password for your MiniDrama account was just changed, and every',
      'device that was signed in has been signed out.',
      '',
      'If this was not you, use "Forgot password" to take the account back.',
    ].join('\n'),
  });
}
