import { createClient } from "@deepgram/sdk";
import { config } from "./config.js";

const deepgram = createClient(config.deepgramApiKey);

export async function transcribeOggBuffer(audio: Buffer): Promise<string> {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audio, {
    model: "nova-3",
    smart_format: true,
    punctuate: true,
    mimetype: "audio/ogg",
  });
  if (error) throw error;
  const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return transcript.trim();
}
