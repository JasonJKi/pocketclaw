import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "./config.js";
import { transcribeOggBuffer } from "./transcribe.js";
import { runClaude, getCwd, setCwd, resetSession } from "./claude.js";
import { chunkForTelegram } from "./chunk.js";

const bot = new Telegraf(config.telegramBotToken);

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== config.allowedUserId) {
    console.warn(`Rejected message from user ${ctx.from?.id} (${ctx.from?.username})`);
    return;
  }
  await next();
});

bot.command("start", (ctx) =>
  ctx.reply(
    [
      "pocketclaw ready.",
      `cwd: ${getCwd()}`,
      "",
      "Send text or a voice note to drive Claude Code.",
      "Commands: /cwd, /cd <path>, /reset",
    ].join("\n"),
  ),
);

bot.command("cwd", (ctx) => ctx.reply(`cwd: ${getCwd()}`));

bot.command("cd", (ctx) => {
  const arg = ctx.message.text.replace(/^\/cd(@\S+)?\s*/, "").trim();
  if (!arg) return ctx.reply("Usage: /cd <absolute-path>");
  setCwd(arg);
  return ctx.reply(`cwd → ${arg}\n(session reset)`);
});

bot.command("reset", (ctx) => {
  resetSession();
  return ctx.reply("Session reset.");
});

async function handlePrompt(ctx: any, prompt: string) {
  if (!prompt.trim()) {
    await ctx.reply("(empty prompt)");
    return;
  }

  const thinking = await ctx.reply(`💭 ${prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt}`);

  try {
    let finalText = "";
    for await (const chunk of runClaude(prompt)) {
      if (chunk.kind === "text") {
        finalText += chunk.text;
      } else if (chunk.kind === "tool") {
        await ctx.reply(`🔧 ${chunk.name}`);
      } else if (chunk.kind === "done") {
        finalText = finalText || chunk.summary;
      }
    }

    const out = finalText.trim() || "(no output)";
    for (const piece of chunkForTelegram(out)) {
      await ctx.reply(piece);
    }
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ ${err?.message ?? String(err)}`);
  } finally {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, thinking.message_id);
    } catch {}
  }
}

bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  await handlePrompt(ctx, ctx.message.text);
});

bot.on(message("voice"), async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  await ctx.reply("🎙️ transcribing…");

  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.toString());
    const audio = Buffer.from(await res.arrayBuffer());
    const transcript = await transcribeOggBuffer(audio);

    if (!transcript) {
      await ctx.reply("(couldn't hear anything)");
      return;
    }
    await ctx.reply(`📝 ${transcript}`);
    await handlePrompt(ctx, transcript);
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ transcription failed: ${err?.message ?? String(err)}`);
  }
});

bot.launch().then(() => {
  console.log(`pocketclaw running. cwd: ${getCwd()}`);
  console.log(`Allowed user: ${config.allowedUserId}`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
