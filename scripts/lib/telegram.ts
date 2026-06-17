/**
 * scripts/lib/telegram.ts — отправка сообщений в Telegram через Bot API.
 *
 * Требует в .env:
 *   TELEGRAM_BOT_TOKEN=<токен от @BotFather>
 *   TELEGRAM_CHAT_ID=<числовой ID канала, например -1001234567890>
 *
 * Telegram ограничивает одно сообщение до 4096 символов — длинные репорты
 * автоматически разбиваются на части с паузой 1 с между ними.
 */

const MAX_MSG_LEN = 4000; // немного меньше лимита, чтобы не обрезать на середине

function getEnv(key: string): string | undefined {
  return process.env[key]?.trim();
}

/** Загружает .env из корня репозитория (на случай если process.env ещё не заполнен). */
function loadEnvIfNeeded(envPath: string): void {
  if (process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env не найден — переменные должны быть заданы иначе
  }
}

/** Разбивает длинный текст на куски не длиннее maxLen символов. */
function splitMessage(text: string, maxLen = MAX_MSG_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Разрыв по последнему переносу строки внутри maxLen
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return parts;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Отправляет одну часть сообщения через Bot API.
 * parse_mode не указываем — отправляем как plain text, чтобы
 * не нужно было экранировать спецсимволы Markdown.
 */
async function sendPart(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Отправляет текст в Telegram-канал.
 * Возвращает true при успехе, false если токен/chat_id не настроен.
 * Бросает ошибку только при сетевом сбое после всех частей.
 */
export async function sendTelegram(
  text: string,
  opts: { envPath?: string } = {},
): Promise<boolean> {
  if (opts.envPath) loadEnvIfNeeded(opts.envPath);

  const token = getEnv("TELEGRAM_BOT_TOKEN");
  const chatId = getEnv("TELEGRAM_CHAT_ID");

  if (!token || token.startsWith("<")) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN не задан — отправка пропущена");
    return false;
  }
  if (!chatId || chatId.startsWith("<")) {
    console.error("[telegram] TELEGRAM_CHAT_ID не задан — отправка пропущена");
    return false;
  }

  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    await sendPart(token, chatId, parts[i]);
    if (i < parts.length - 1) await sleep(1000);
  }
  return true;
}
