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

import { readFileSync } from "node:fs";

const MAX_MSG_LEN = 4000; // немного меньше лимита, чтобы не обрезать на середине

function getEnv(key: string): string | undefined {
  return process.env[key]?.trim();
}

/** Загружает .env из корня репозитория (на случай если process.env ещё не заполнен). */
function loadEnvIfNeeded(envPath: string): void {
  // Both vars are needed; checking only the token meant a token-in-environment
  // + chat-id-in-file setup never read the file and reported "not configured".
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) return;
  try {
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (err) {
    // Previously a bare `catch {}` that also swallowed the ReferenceError from
    // calling require() in an ESM module, so failures looked like "no .env".
    console.error(`[telegram] could not read ${envPath}: ${(err as Error).message}`);
  }
}

/**
 * Разбивает текст на части, у которых РЕНДЕР В HTML укладывается в maxLen.
 *
 * Splitting the Markdown at 4000 was the wrong measurement: what gets POSTed is
 * the HTML, and the HTML is strictly longer (`&` → `&amp;`, `**x**` →
 * `<b>x</b>`, each heading → `<b></b>`). A part packed with headings and bold
 * spans crossed Telegram's hard 4096 limit and the send failed with 400.
 */
export function splitMessage(text: string, maxLen = MAX_MSG_LEN): string[] {
  if (markdownToHtml(text).length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (markdownToHtml(remaining).length <= maxLen) {
      parts.push(remaining);
      break;
    }

    // Shrink the candidate until its rendered form fits. Prefer a line break so
    // formatting spans (which are line-scoped) are never cut in half.
    let cut = Math.min(remaining.length, maxLen);
    for (;;) {
      const lineBreak = remaining.lastIndexOf("\n", cut);
      const candidateEnd = lineBreak > 0 ? lineBreak : cut;
      const candidate = remaining.slice(0, candidateEnd);
      if (markdownToHtml(candidate).length <= maxLen || candidateEnd <= 1) {
        parts.push(candidate);
        remaining = remaining.slice(candidateEnd).trimStart();
        break;
      }
      // Back off proportionally to how far over we are, so this converges in a
      // handful of iterations rather than one character at a time.
      const overshoot = markdownToHtml(candidate).length / maxLen;
      cut = Math.max(1, Math.floor(candidateEnd / overshoot) - 1);
    }
  }

  return parts;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Конвертирует базовый Markdown в HTML для Telegram.
 *
 * URLs are pulled out into placeholders before any character stripping runs.
 * The previous version stripped `_~\`` from the finished HTML, which also ate
 * underscores inside the hrefs it had just generated — every link containing
 * one (Polymarket and Kalshi slugs routinely do) came out broken.
 */
export function markdownToHtml(md: string): string {
  const urls: string[] = [];
  // U+0000 cannot appear in a report, so it is a safe placeholder delimiter.
  // Written as a \u0000 escape rather than the raw byte: a literal NUL in
  // the source makes git classify this file as binary, so every change to it
  // showed up as an unreviewable "Bin 4065 -> 8742 bytes" instead of a diff.
  const placeholder = (i: number) => `\u0000LINK${i}\u0000`;

  let html = md.replace(/\[(.*?)\]\((.*?)\)/g, (_all, text: string, url: string) => {
    urls.push(url);
    return `${placeholder(urls.length - 1)}${text}\u0000/LINK\u0000`;
  });

  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html
    // ### and deeper first, otherwise the single-# rule leaves literal hashes.
    .replace(/^#{3,}\s+(.*)$/gm, "<b>$1</b>")
    .replace(/^##\s+(.*)$/gm, "<b>$1</b>")
    .replace(/^#\s+(.*)$/gm, "<b>$1</b>")
    .replace(/\*\*(.*?)\*\*/gs, "<b>$1</b>")
    .replace(/\*(.*?)\*/g, "<i>$1</i>")
    .replace(/^-\s+(.*)$/gm, "• $1");

  // Leftover Markdown emphasis characters Telegram would render literally.
  html = html.replace(/[_~`]/g, "");

  // Restore links. The href is escaped here, not earlier, so it never passed
  // through the stripping pass above.
  html = html.replace(/\u0000LINK(\d+)\u0000([\s\S]*?)\u0000\/LINK\u0000/g, (_all, idx: string, text: string) => {
    const url = (urls[Number(idx)] ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<a href="${url}">${text}</a>`;
  });

  return html;
}

/**
 * Отправляет одну часть сообщения через Bot API.
 * Конвертирует Markdown в HTML и отправляет с parse_mode: HTML.
 */
async function sendPart(token: string, chatId: string, text: string): Promise<void> {
  const htmlText = markdownToHtml(text);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: htmlText, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await res.text().catch(() => "");

    if (res.ok) {
      // Telegram can answer 200 with {"ok":false,...}. res.ok alone misses it.
      try {
        const parsed = JSON.parse(body) as { ok?: boolean; description?: string };
        if (parsed.ok === false) {
          throw new Error(`Telegram API returned ok:false — ${parsed.description ?? body.slice(0, 200)}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Telegram API")) throw err;
        // Unparseable but 200 — treat as delivered.
      }
      return;
    }

    // 429 carries retry_after (seconds). Honour it instead of giving up.
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(body.match(/"retry_after"\s*:\s*(\d+)/)?.[1] ?? 0);
      const waitMs = (retryAfter > 0 ? retryAfter : 5 * attempt) * 1000;
      console.error(`[telegram] rate limited, retrying in ${waitMs}ms (attempt ${attempt}/3)`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 300)}`);
  }

  throw new Error("Telegram API: rate limit persisted after 3 attempts");
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

  // "..." is the placeholder shape used elsewhere in .env; "<...>" is the other.
  const isPlaceholder = (v: string) => v === "..." || v.startsWith("<");

  if (!token || isPlaceholder(token)) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN не задан — отправка пропущена");
    return false;
  }
  if (!chatId || isPlaceholder(chatId)) {
    console.error("[telegram] TELEGRAM_CHAT_ID не задан — отправка пропущена");
    return false;
  }

  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    try {
      await sendPart(token, chatId, parts[i]);
    } catch (err) {
      // Report which part died. Failing on part 3 of 5 leaves 1-2 already
      // published; silently throwing made that look like a total non-delivery.
      throw new Error(
        `Telegram send failed on part ${i + 1}/${parts.length} (${i} part(s) already delivered): ${(err as Error).message}`,
      );
    }
    if (i < parts.length - 1) await sleep(1000);
  }
  return true;
}
