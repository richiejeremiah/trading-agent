'use strict';

/**
 * Sending the verification code.
 *
 * Kept separate from the identity service on purpose: the security logic should
 * not need touching when the mail provider changes, and the mail provider should
 * not be able to see how codes are hashed.
 *
 * Three implementations, chosen by what is configured:
 *
 *   console — prints the code to the server log. Not a placeholder to be
 *     replaced later so much as the right thing during development: no signup,
 *     no domain, and the whole flow is testable in a minute.
 *
 *   resend — RESEND_API_KEY. Free tier covers three thousand a month. Without a
 *     verified domain it will only deliver to the address that owns the account,
 *     which for a single-user agent is not a restriction.
 *
 *   smtp — SMTP_URL, for anything else. Requires nodemailer to be installed;
 *     if it is not, this falls back to console rather than failing a login.
 */

const PROVIDER = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
const FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function subjectFor(code) {
  // The code goes in the subject as well as the body — most people read it from
  // a notification without opening anything.
  return code + ' is your trading agent code';
}

function bodyFor(code, minutes) {
  return [
    'Your verification code is ' + code,
    '',
    'It expires in ' + minutes + ' minutes and can be used once.',
    '',
    'If you did not ask for this, someone typed your address into a Telegram bot.',
    'Nothing has been linked to your account and you can ignore this.',
  ].join('\n');
}

async function sendViaResend(to, code, minutes) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) return err('NOT_CONFIGURED', 'RESEND_API_KEY is not set.');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: subjectFor(code),
        text: bodyFor(code, minutes),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return err('SEND_FAILED', 'Resend returned ' + res.status + ': ' + detail.slice(0, 200));
    }
    return { ok: true, data: { provider: 'resend', to } };
  } catch (e) {
    return err('SEND_FAILED', e.message);
  }
}

async function sendViaSmtp(to, code, minutes) {
  const url = (process.env.SMTP_URL || '').trim();
  if (!url) return err('NOT_CONFIGURED', 'SMTP_URL is not set.');

  let nodemailer;
  try {
    // eslint-disable-next-line global-require
    nodemailer = require('nodemailer');
  } catch {
    return err('NOT_CONFIGURED', 'SMTP_URL is set but nodemailer is not installed.');
  }

  try {
    const transport = nodemailer.createTransport(url);
    await transport.sendMail({
      from: FROM,
      to,
      subject: subjectFor(code),
      text: bodyFor(code, minutes),
    });
    return { ok: true, data: { provider: 'smtp', to } };
  } catch (e) {
    return err('SEND_FAILED', e.message);
  }
}

function sendViaConsole(to, code, minutes) {
  console.log(
    '\n[email] to ' + to + '\n[email] code ' + code + ' (' + minutes + ' minutes)\n'
  );
  return { ok: true, data: { provider: 'console', to } };
}

/**
 * Send a code. Returns the ok/error union the rest of the codebase uses.
 *
 * A send failure must be visible to the caller — a bot that says "check your
 * email" when nothing was sent leaves someone waiting for a message that will
 * never arrive.
 */
async function sendVerificationCode(to, code, minutes) {
  if (PROVIDER === 'resend' || (!PROVIDER && process.env.RESEND_API_KEY)) {
    return sendViaResend(to, code, minutes);
  }
  if (PROVIDER === 'smtp' || (!PROVIDER && process.env.SMTP_URL)) {
    return sendViaSmtp(to, code, minutes);
  }
  return sendViaConsole(to, code, minutes);
}

/** Which provider will actually be used, for logging at startup. */
function activeProvider() {
  if (PROVIDER === 'resend' || (!PROVIDER && process.env.RESEND_API_KEY)) return 'resend';
  if (PROVIDER === 'smtp' || (!PROVIDER && process.env.SMTP_URL)) return 'smtp';
  return 'console';
}

module.exports = { sendVerificationCode, activeProvider };
