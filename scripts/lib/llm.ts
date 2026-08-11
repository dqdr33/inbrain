/**
 * scripts/lib/llm.ts — the Gemini call path shared by run-prediction-cycle.ts
 * and run-dream-cycle.ts.
 *
 * These ~130 lines used to be copy-pasted into both runners and had already
 * drifted apart; every fix had to be applied twice and one of the two always
 * got missed. Single copy now.
 */

import { isKeyExhaustedError, retryDelayMs, type KeyPool } from "./gemini-keys.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** Pull JSON out of a ```json fence. Returns the text unchanged when unfenced. */
export function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : text;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LlmCallOptions {
  model?: string;
}

/** Token counts accumulated across every call made through one LlmCall.
 *
 *  Gemini reports these per response in `usageMetadata`; the field used to be
 *  dropped on the floor, which is why "how much of the paid key's credit did
 *  this cycle burn?" had no answer at all. Counting is free — the numbers are
 *  already in the body we parse. */
export interface LlmUsageTotals {
  calls: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type LlmCall = ((
  system: string,
  prompt: string,
  opts?: LlmCallOptions,
) => Promise<string>) & {
  /** Running totals for this call path. Safe to read at any point. */
  usage(): LlmUsageTotals;
};

export interface CreateLlmCallOpts {
  /** Model id; per-call opts.model overrides it. */
  model?: string;
  /** Minimum spacing between requests — the free tier's RPM is tight. */
  minGapMs?: number;
  /** Hard deadline per HTTP request. Without it a hung socket stalls forever:
   *  a stalled fetch never rejects, so the retry loop is never reached. */
  timeoutMs?: number;
}

export function createLlmCall(keyPool: KeyPool, opts: CreateLlmCallOpts = {}): LlmCall {
  const defaultModel = opts.model ?? DEFAULT_GEMINI_MODEL;
  const minGapMs = opts.minGapMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Serialise the rate limiter. Reading lastCallAt and writing it back is a
  // read-modify-write: two concurrent callers both observed the same gap and
  // fired together, defeating the limiter entirely.
  let gate: Promise<void> = Promise.resolve();
  let lastCallAt = 0;

  async function throttle(): Promise<void> {
    const mine = gate.then(async () => {
      const gap = Date.now() - lastCallAt;
      if (gap < minGapMs) await sleep(minGapMs - gap);
      lastCallAt = Date.now();
    });
    gate = mine.catch(() => {});
    return mine;
  }

  const totals: LlmUsageTotals = { calls: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0 };

  const llmCall = async function llmCall(
    system: string,
    prompt: string,
    callOpts?: LlmCallOptions,
  ): Promise<string> {
    const model = callOpts?.model ?? defaultModel;
    const url = geminiUrl(model);
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: prompt }] }],
    });

    // Outer loop: cross-key rotation. Inner loop: same-key retry for transient
    // errors (5xx, per-minute throttle, network blips).
    for (;;) {
      const key = keyPool.current();

      for (let attempt = 1; attempt <= 3; attempt++) {
        await throttle();

        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (attempt === 3) throw err;
          console.error(
            `[llmCall] network error (attempt ${attempt}/3), retrying: ${(err as Error).message}`,
          );
          await sleep(5_000 * attempt);
          continue;
        }

        if (res.ok) {
          let json: {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
              finishReason?: string;
            }>;
            promptFeedback?: { blockReason?: string };
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          };
          try {
            json = await res.json();
          } catch (err) {
            // 200 with a truncated or non-JSON body. Retrying is right; the
            // old code let a raw SyntaxError escape and be misreported by the
            // caller as "the model produced bad JSON".
            if (attempt === 3) {
              throw new Error(`Gemini returned an unparseable 200 body: ${(err as Error).message}`);
            }
            await sleep(3_000 * attempt);
            continue;
          }

          if (json.promptFeedback?.blockReason) {
            throw new Error(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`);
          }
          const candidate = json.candidates?.[0];
          const finish = candidate?.finishReason;
          // MAX_TOKENS / SAFETY produce a partial or empty body. Silently
          // returning it made a truncated response indistinguishable from a
          // genuinely bad signal downstream.
          if (finish && finish !== "STOP") {
            throw new Error(`Gemini stopped early (finishReason=${finish}) — response unusable`);
          }
          const text = candidate?.content?.parts?.[0]?.text ?? "";
          if (!text.trim()) {
            throw new Error("Gemini returned an empty completion");
          }
          // Counted only for a response we actually use. A retried 5xx costs
          // wall-clock, not tokens, so folding those in would overstate spend.
          const usage = json.usageMetadata;
          totals.calls += 1;
          totals.promptTokens += usage?.promptTokenCount ?? 0;
          totals.outputTokens += usage?.candidatesTokenCount ?? 0;
          totals.totalTokens +=
            usage?.totalTokenCount ??
            (usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0);
          return stripFences(text);
        }

        const bodyText = await res.text().catch(() => "");

        if (isKeyExhaustedError(res.status, bodyText)) {
          const nextKey = keyPool.rotate(`HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
          if (nextKey === null) {
            throw new Error(
              `All ${keyPool.size()} Gemini key(s) exhausted. Last error: ${bodyText.slice(0, 300)}`,
            );
          }
          // Subprocesses (the inbrain CLI) inherit process.env, so the rotated
          // key has to land here too or they keep using the dead one.
          process.env.GOOGLE_GENERATIVE_AI_API_KEY = nextKey;
          break; // restart outer loop with the new key
        }

        // A 429 that is NOT exhaustion is the per-minute throttle: wait it out
        // on the SAME key rather than burning a healthy key for the whole day.
        if (res.status === 429) {
          if (attempt === 3) {
            throw new Error(`Gemini rate limit persisted after 3 attempts: ${bodyText.slice(0, 300)}`);
          }
          const wait = retryDelayMs(bodyText) ?? 30_000 * attempt;
          console.error(`[llmCall] 429 (per-minute), waiting ${wait}ms on the same key (attempt ${attempt}/3)`);
          await sleep(wait);
          continue;
        }

        if (res.status === 503 || res.status === 504) {
          if (attempt === 3) {
            throw new Error(`Gemini HTTP ${res.status} (transient, exhausted retries): ${bodyText.slice(0, 300)}`);
          }
          const backoff = 8_000 * attempt;
          console.error(`[llmCall] ${res.status} (transient), retrying same key in ${backoff}ms (attempt ${attempt}/3)`);
          await sleep(backoff);
          continue;
        }

        throw new Error(`Gemini HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
      }
    }
  } as LlmCall;

  // Snapshot, not the live object — a caller that stashes the result must not
  // watch it mutate underneath them.
  llmCall.usage = () => ({ ...totals });

  return llmCall;
}

/** One-line spend summary for the end of a cycle. Token counts are exact
 *  (Google reports them); the dollar figure is deliberately absent — the price
 *  per token is not something this process can know, and a guessed number in a
 *  log reads as measured fact. Feed these counts into the current published
 *  rate to get cost. */
export function formatUsage(totals: LlmUsageTotals): string {
  return (
    `${totals.calls} call(s), ${totals.promptTokens.toLocaleString("en-US")} prompt + ` +
    `${totals.outputTokens.toLocaleString("en-US")} output = ` +
    `${totals.totalTokens.toLocaleString("en-US")} tokens`
  );
}
