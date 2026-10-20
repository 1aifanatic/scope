// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ArtifactError, artifactUrl, fetchArtifact } from "./artifact-delivery";

const responseHeaders = ["content-type", "content-range", "content-length", "accept-ranges", "content-disposition"];

async function mediaWorker(signal: AbortSignal): Promise<ServiceWorker> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    throw new Error("Authenticated video requires a secure browser with service-worker support.");
  }
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const script = new URL("scope-media-worker.js", base).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  signal.throwIfAborted();
  if (registrations.some(registration => {
    const worker = registration.active ?? registration.waiting ?? registration.installing;
    return base.href.startsWith(registration.scope) && worker?.scriptURL !== script;
  })) throw new Error("Another service worker controls this app. Authenticated video cannot replace it.");
  await navigator.serviceWorker.register(script, { scope: base.pathname, updateViaCache: "none" });
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      if (error) reject(error);
      else resolve(navigator.serviceWorker.controller!);
    };
    const aborted = () => finish(new DOMException("Video session canceled.", "AbortError"));
    const changed = () => {
      const controller = navigator.serviceWorker.controller;
      if (controller?.scriptURL === script) finish();
      else if (controller) finish(new Error("An incompatible service worker controls this page."));
    };
    const timer = setTimeout(() => finish(new Error("Video delivery could not acquire this page. Reload and reopen the recording.")), 10_000);
    signal.addEventListener("abort", aborted, { once: true });
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    if (signal.aborted) aborted();
    else changed();
  });
}

export interface MediaBridge {
  url: string;
  close(): void;
}

export async function openAuthenticatedMedia(
  path: string, projectId: string, signal: AbortSignal, onError: (message: string) => void,
): Promise<MediaBridge> {
  const canonical = artifactUrl(path, projectId);
  if (!canonical.pathname.endsWith("/video")) throw new Error("The media bridge only serves Scope video routes.");
  const worker = await mediaWorker(signal);
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const requests = new Set<AbortController>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const controller of requests) controller.abort();
    channel.port1.postMessage({ type: "close" });
    channel.port1.close();
    signal.removeEventListener("abort", close);
    window.removeEventListener("pagehide", close);
    navigator.serviceWorker.removeEventListener("controllerchange", replaced);
  };
  const fail = (message: string) => { if (!signal.aborted && !closed) onError(message); close(); };
  const replaced = () => fail("Video delivery restarted. Reopen the recording.");
  signal.addEventListener("abort", close, { once: true });
  window.addEventListener("pagehide", close);
  navigator.serviceWorker.addEventListener("controllerchange", replaced);

  async function serve(port: MessagePort, range: unknown) {
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    requests.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading = false;
    const finish = () => {
      controller.abort();
      requests.delete(controller);
      port.close();
    };
    port.onmessageerror = () => { finish(); fail("Video stream connection failed."); };
    port.onmessage = async event => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type === "cancel") { finish(); return; }
      if (data.type !== "pull" || reading || !reader || requestSignal.aborted) return;
      reading = true;
      try {
        const chunk = await reader.read();
        requestSignal.throwIfAborted();
        if (chunk.done) { port.postMessage({ type: "end" }); finish(); }
        else port.postMessage({ type: "chunk", bytes: chunk.value });
      } catch (cause) {
        if (!closed && !requestSignal.aborted) {
          const message = cause instanceof Error ? cause.message : "Video stream failed.";
          port.postMessage({ type: "error", message });
          fail(message);
        }
        finish();
      } finally { reading = false; }
    };
    try {
      if (closed || requestSignal.aborted) throw new DOMException("Video closed.", "AbortError");
      if (range !== null && (typeof range !== "string" || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) {
        throw new ArtifactError("Unsupported video range.", 416);
      }
      const response = await fetchArtifact(canonical.href, projectId, requestSignal, range ?? undefined);
      requestSignal.throwIfAborted();
      if (!response.body || ![200, 206].includes(response.status)) throw new Error("No video stream was returned.");
      reader = response.body.getReader();
      port.postMessage({
        type: "headers", status: response.status,
        headers: responseHeaders.flatMap(key => {
          const value = response.headers.get(key);
          return value === null ? [] : [[key, value]];
        }),
      });
    } catch (cause) {
      if (!closed && !requestSignal.aborted) {
        const message = cause instanceof Error ? cause.message : "Unable to load recording.";
        port.postMessage({ type: "error", status: cause instanceof ArtifactError ? cause.status : 503, message });
        fail(message);
      }
      finish();
    }
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { close(); reject(new Error("Video bridge did not respond.")); }, 10_000);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Video canceled.", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = event => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type === "ready") {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      } else if (data.type === "fetch" && "range" in data && event.ports[0]) {
        void serve(event.ports[0], data.range);
      } else if (data.type === "closed" && "message" in data && typeof data.message === "string") {
        fail(data.message);
      }
    };
    worker.postMessage({ type: "scope-media-open", id }, [channel.port2]);
  });
  signal.throwIfAborted();
  return { url: new URL(`__scope_media__/${id}`, new URL(import.meta.env.BASE_URL, window.location.origin)).href, close };
}
