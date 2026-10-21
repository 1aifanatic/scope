// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { open } from "node:fs/promises";

const MAX_BYTES = 2 * 1024 * 1024;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
class HttpFailure extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) { super(`ATIF download failed: HTTP ${status}`); }
}
async function downloadAttempt(location: string, limit: number, timeout: number): Promise<string> {
  let url = new URL(location);
  if (url.username || url.password) throw new Error("ATIF URL userinfo is not supported");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 3) throw new Error("ATIF redirect limit exceeded");
      const target = response.headers.get("location");
      if (!target) throw new Error("ATIF redirect is missing Location");
      const next = new URL(target, url);
      if (!["http:", "https:"].includes(next.protocol) || next.username || next.password ||
          (url.protocol === "https:" && next.protocol !== "https:")) throw new Error("Unsafe ATIF redirect");
      url = next;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpFailure(response.status, response.headers.get("retry-after"));
    }
    if (Number(response.headers.get("content-length")) > limit) throw new Error(`JSON input exceeds ${limit} bytes`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("ATIF download has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > limit) throw new Error(`JSON input exceeds ${limit} bytes`);
        chunks.push(item.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  } catch (error) {
    if (controller.signal.aborted) throw new TypeError("ATIF download attempt timed out");
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}
function retryDelay(header: string | null, attempt: number): number {
  if (!header) return 100 * 2 ** attempt;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return 100 * 2 ** attempt;
  if (delay > 2000) throw new Error("ATIF Retry-After exceeds the allowed 2-second wait budget; retry later");
  return delay;
}
export async function loadJson(location: string, options: { maxBytes?: number; timeoutMs?: number; attempts?: number } = {}): Promise<unknown> {
  const limit = options.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BYTES) throw new Error("JSON byte limit must be 1..2097152");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10_000)) throw new Error("Download timeout must be 1..10000ms");
  if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 3)) throw new Error("Download attempts must be 1..3");
  let text: string;
  if (!/^https?:\/\//i.test(location)) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(location)) throw new Error("Only local files and HTTP(S) URLs are supported");
    const file = await open(location, "r");
    try {
      if ((await file.stat()).size > limit) throw new Error(`JSON input exceeds ${limit} bytes`);
      const bytes = Buffer.alloc(limit + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > limit) throw new Error(`JSON input exceeds ${limit} bytes`);
      text = bytes.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } else {
    try { new URL(location); } catch { throw new Error("Invalid HTTP(S) ATIF URL"); }
    const timeout = options.timeoutMs ?? 10_000, attempts = options.attempts ?? 3;
    let body: string | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        body = await downloadAttempt(location, limit, timeout);
        break;
      } catch (error) {
        if (error instanceof HttpFailure) {
          if (!TRANSIENT.has(error.status) || attempt + 1 >= attempts) throw error;
        } else if (!(error instanceof TypeError)) throw error;
        else if (attempt + 1 >= attempts) throw new Error("ATIF download failed after bounded network attempts");
        await new Promise(resolve => setTimeout(resolve, retryDelay(error instanceof HttpFailure ? error.retryAfter : null, attempt)));
      }
    }
    if (body === undefined) throw new Error("ATIF download failed");
    text = body;
  }
  try { return JSON.parse(text) as unknown; } catch { throw new Error("Invalid JSON input"); }
}
