// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* This worker holds only client-bound ports, never bearer tokens or cached bytes. */
const sessions = new Map();
const bridgePath = new URL("__scope_media__/", self.registration.scope).pathname;
const idleMs = 5 * 60 * 1000;

function closeSession(id, message) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.timer);
  for (const cancel of session.pending) cancel(message);
  session.port.postMessage({ type: "closed", message });
  session.port.close();
}

function touch(id, session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => closeSession(id, "Video session expired. Reopen the recording."), idleMs);
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "scope-media-open" || !/^[a-f0-9-]{36}$/.test(data.id) ||
      !event.source || event.source.type !== "window" || !event.ports[0]) return;
  const source = event.source;
  if (new URL(source.url).origin !== self.location.origin) return;
  if (sessions.has(data.id)) return;
  const session = { clientId: source.id, port: event.ports[0], pending: new Set(), timer: null };
  sessions.set(data.id, session);
  session.port.onmessage = message => {
    if (message.data?.type === "close") closeSession(data.id, "Video session closed.");
  };
  session.port.onmessageerror = () => closeSession(data.id, "Video connection failed.");
  touch(data.id, session);
  session.port.postMessage({ type: "ready" });
});

function failure(status, message) {
  return new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
}

async function mediaResponse(event, id) {
  const session = sessions.get(id);
  if (!session || !event.clientId || event.clientId !== session.clientId) {
    return failure(403, "This recording belongs to a different or expired browser client.");
  }
  if (event.request.method !== "GET") return failure(405, "Only video GET requests are allowed.");
  const client = await self.clients.get(session.clientId);
  if (!client || new URL(client.url).origin !== self.location.origin) {
    closeSession(id, "The originating page is no longer available.");
    return failure(410, "Video session closed.");
  }
  if (session.pending.size >= 4) return failure(429, "Too many concurrent video ranges.");
  touch(id, session);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let stream;
    let headersReceived = false;
    let finished = false;
    let timer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.pending.delete(cancel);
      event.request.signal.removeEventListener("abort", abort);
      channel.port1.close();
    };
    const cancel = message => {
      if (finished) return;
      channel.port1.postMessage({ type: "cancel" });
      if (headersReceived) stream?.error(new Error(message));
      else resolve(failure(503, message));
      finish();
    };
    const abort = () => cancel("Video range canceled.");
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cancel("Video range timed out."), 30_000);
    };
    session.pending.add(cancel);
    event.request.signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessageerror = () => cancel("Invalid video stream message.");
    channel.port1.onmessage = message => {
      if (finished) return;
      const data = message.data;
      touch(id, session);
      clearTimeout(timer);
      if (data?.type === "headers" && !headersReceived) {
        if (![200, 206].includes(data.status) || !Array.isArray(data.headers)) {
          cancel("Invalid video response.");
          return;
        }
        const headers = new Headers(data.headers);
        headers.set("Cache-Control", "no-store");
        headersReceived = true;
        const body = new ReadableStream({
          start(controller) { stream = controller; },
          pull() { armTimeout(); channel.port1.postMessage({ type: "pull" }); },
          cancel() { channel.port1.postMessage({ type: "cancel" }); finish(); },
        }, { highWaterMark: 0 });
        resolve(new Response(body, { status: data.status, headers }));
      } else if (data?.type === "chunk" && headersReceived && data.bytes instanceof Uint8Array) {
        stream.enqueue(data.bytes);
      } else if (data?.type === "end" && headersReceived) {
        stream.close();
        finish();
      } else if (data?.type === "error") {
        const status = Number.isInteger(data.status) && data.status >= 400 && data.status <= 599 ? data.status : 503;
        if (headersReceived) stream.error(new Error(data.message || "Video delivery failed."));
        else resolve(failure(status, data.message || "Video delivery failed."));
        finish();
      } else cancel("Invalid video stream message.");
    };
    armTimeout();
    if (event.request.signal.aborted) abort();
    else session.port.postMessage({ type: "fetch", range: event.request.headers.get("range") }, [channel.port2]);
  });
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(bridgePath)) return;
  const id = url.pathname.slice(bridgePath.length);
  event.respondWith(url.search || !/^[a-f0-9-]{36}$/.test(id)
    ? failure(404, "Invalid video bridge route.")
    : mediaResponse(event, id));
});
