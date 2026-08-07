'use strict';

/**
 * Hard gate for Telegram money commands.
 * Empty TELEGRAM_ALLOWED_USER_IDS → money commands disabled.
 */

function parseIdList(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function moneyCommandsEnabled() {
  return parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS).length > 0;
}

/**
 * @param {string|number} userId
 * @param {string|number|null|undefined} chatId
 * @returns {{ ok: true, userId: string, chatId: string|null }}
 * @throws {{ code: string, message: string }}
 */
function assertTelegramCaller(userId, chatId) {
  const allowedUsers = parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowedUsers.length === 0) {
    const err = new Error('Money commands disabled: TELEGRAM_ALLOWED_USER_IDS is empty');
    err.code = 'MONEY_COMMANDS_DISABLED';
    throw err;
  }

  const uid = userId == null ? '' : String(userId).trim();
  if (!uid || !allowedUsers.includes(uid)) {
    const err = new Error('unauthorized');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const allowedChats = parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const cid = chatId == null || chatId === '' ? null : String(chatId).trim();
  if (allowedChats.length > 0) {
    if (!cid || !allowedChats.includes(cid)) {
      const err = new Error('unauthorized');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
  }

  return { ok: true, userId: uid, chatId: cid };
}

module.exports = {
  assertTelegramCaller,
  moneyCommandsEnabled,
  parseIdList,
};
