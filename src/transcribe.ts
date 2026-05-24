import { createClient } from "@deepgram/sdk";
import { config } from "./config.js";

const TRANSCRIBE_TIMEOUT_MS = 60_000;

// Lazy-initialize Deepgram client only when needed
let deepgram: ReturnType<typeof createClient> | null = null;

function getDeepgramClient() {
  if (!config.deepgramApiKey) {
    throw new Error("Deepgram API key not configured. Voice transcription is disabled.");
  }
  if (!deepgram) {
    deepgram = createClient(config.deepgramApiKey);
  }
  return deepgram;
}

export async function transcribeOggBuffer(audio: Buffer): Promise<string> {
  const client = getDeepgramClient();

  const call = client.listen.prerecorded.transcribeFile(audio, {
    model: "nova-3",
    smart_format: true,
    punctuate: true,
    mimetype: "audio/ogg",
  });

  const { result, error } = await Promise.race([
    call,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`Deepgram timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s`)),
        TRANSCRIBE_TIMEOUT_MS,
      );
      t.unref();
    }),
  ]);

  if (error) throw error;
  const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return transcript.trim();
}

export function isTranscriptionEnabled(): boolean {
  return !!config.deepgramApiKey;
}
