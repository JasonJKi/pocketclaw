import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "./config.js";
import { transcribeOggBuffer } from "./transcribe.js";
import { runClaude, getCwd, setCwd, resetSession } from "./claude.js";
import { chunkForTelegram } from "./chunk.js";

const bot = new Telegraf(config.telegramBotToken, {
  handlerTimeout: Infinity,
});

// Best-effort reply for progress/status pings. Swallows send errors so
// a transient Telegram failure (rate limit, network blip) can't kill an
// in-flight Claude turn or leave a stuck session behind.
async function tryReply(ctx: any, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err: any) {
    console.warn(`reply failed: ${err?.message ?? String(err)}`);
  }
}

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
  try {
    setCwd(arg);
  } catch (err: any) {
    return ctx.reply(`❌ ${err?.message ?? String(err)}`);
  }
  return ctx.reply(`cwd → ${arg}\n(session reset)`);
});

bot.command("reset", (ctx) => {
  resetSession();
  return ctx.reply("Session reset.");
});

async function handlePrompt(ctx: any, prompt: string) {
  if (!prompt.trim()) {
    await tryReply(ctx, "(empty prompt)");
    return;
  }

  let thinkingId: number | undefined;
  try {
    const thinking = await ctx.reply(`💭 ${prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt}`);
    thinkingId = thinking.message_id;
  } catch (err: any) {
    console.warn(`thinking-reply failed: ${err?.message ?? String(err)}`);
  }

  let claudeFinished = false;
  try {
    let finalText = "";
    for await (const chunk of runClaude(prompt)) {
      if (chunk.kind === "text") {
        finalText += chunk.text;
      } else if (chunk.kind === "tool") {
        await tryReply(ctx, `🔧 ${chunk.name}`);
      } else if (chunk.kind === "done") {
        finalText = finalText || chunk.summary;
      }
    }
    claudeFinished = true;

    const out = finalText.trim() || "(no output)";
    const pieces = chunkForTelegram(out);
    let delivered = 0;
    for (const piece of pieces) {
      try {
        await ctx.reply(piece);
        delivered++;
      } catch (err: any) {
        console.error(`final-reply piece ${delivered + 1}/${pieces.length} failed:`, err);
        await tryReply(ctx, `⚠️ delivery failed at piece ${delivered + 1}/${pieces.length}: ${err?.message ?? String(err)}`);
        break;
      }
    }
  } catch (err: any) {
    console.error(err);
    // Only reset the session if Claude itself failed mid-turn. If the
    // failure happened after Claude finished (delivery-only), the work
    // is real and worth keeping in the resume chain.
    if (!claudeFinished) resetSession();
    await tryReply(
      ctx,
      claudeFinished
        ? `❌ ${err?.message ?? String(err)}`
        : `❌ ${err?.message ?? String(err)}\n(session reset)`,
    );
  } finally {
    if (thinkingId !== undefined) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkingId);
      } catch {}
    }
  }
}

bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  await handlePrompt(ctx, ctx.message.text);
});

bot.on(message("voice"), async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  await tryReply(ctx, "🎙️ transcribing…");

  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.toString(), { signal: AbortSignal.timeout(30_000) });
    const audio = Buffer.from(await res.arrayBuffer());
    const transcript = await transcribeOggBuffer(audio);

    if (!transcript) {
      await tryReply(ctx, "(couldn't hear anything)");
      return;
    }
    await tryReply(ctx, `📝 ${transcript}`);
    await handlePrompt(ctx, transcript);
  } catch (err: any) {
    console.error(err);
    await tryReply(ctx, `❌ transcription failed: ${err?.message ?? String(err)}`);
  }
});

// Surface anything that escapes a handler so we see it in logs instead
// of failing silently. pm2 will restart on uncaughtException.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});

bot
  .launch()
  .then(() => {
    console.log(`pocketclaw running. cwd: ${getCwd()}`);
    console.log(`Allowed user: ${config.allowedUserId}`);
  })
  .catch((err) => {
    console.error("bot.launch failed:", err);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
