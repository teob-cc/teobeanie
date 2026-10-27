// stt.ts — speech to text over the OpenAI transcription API (POST
// /v1/audio/transcriptions, multipart). The default server is Teobeanie Whisper, the
// sibling add-on from the same repository (faster-whisper on the Home Assistant host);
// any server that speaks the API will do (stt_url).

import { hostname } from "node:os";

export interface Transcript {
  text: string;
  /** The language heard (or the one asked for). */
  language?: string;
  /** Seconds of audio. */
  duration?: number;
  /** The model that heard it, as the server names it. */
  model?: string;
  /** How long the server took, ms. */
  ms: number;
}

export interface Transcriber {
  readonly url: string;
  transcribe(audio: Uint8Array, opts: { filename: string; language?: string; prompt?: string }): Promise<Transcript>;
}

/**
 * The sibling add-on's address: an add-on's hostname is its slug with dashes
 * (32ce46bf-teobeanie), so Teobeanie Whisper of the same repository is that plus -whisper.
 */
export function siblingWhisperUrl(host = hostname()): string {
  return `http://${host}-whisper:8200`;
}

export function createTranscriber(opts: { url: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Transcriber {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/audio/transcriptions") ? base : `${base}/v1/audio/transcriptions`;
  return {
    url: base,
    async transcribe(audio, o) {
      const form = new FormData();
      form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>]), o.filename);
      form.append("model", "whisper-1");
      form.append("response_format", "json");
      if (o.language) form.append("language", o.language);
      if (o.prompt) form.append("prompt", o.prompt);
      const t0 = Date.now();
      const res = await f(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
      if (!res.ok) throw new Error(`speech to text ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { text?: unknown; language?: unknown; duration?: unknown; model?: unknown };
      if (typeof body.text !== "string") throw new Error("speech to text: no text in the answer");
      return {
        text: body.text.trim(),
        ...(typeof body.language === "string" ? { language: body.language } : {}),
        ...(typeof body.duration === "number" ? { duration: body.duration } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ms: Date.now() - t0,
      };
    },
  };
}
