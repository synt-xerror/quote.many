import { createCanvas, loadImage } from "canvas";
import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { get } from "https";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function render(config) {
  const { width, height, imgPortion, fadeWidth, padding } = config;

  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext("2d");

  const imgW      = Math.floor(width * imgPortion);
  const textX     = imgW + padding;
  const textAreaW = width - imgW - padding * 2;

  // Fundo preto
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  // Imagem em P&B
  const photo      = await loadImage(config.imagePath);
  const offscreen  = createCanvas(imgW, height);
  const offCtx     = offscreen.getContext("2d");

  const scale = Math.max(imgW / photo.width, height / photo.height);
  const sw = photo.width  * scale;
  const sh = photo.height * scale;
  const sx = (imgW - sw) / 2;
  const sy = (height - sh) / 2;

  offCtx.drawImage(photo, sx, sy, sw, sh);

  const imageData = offCtx.getImageData(0, 0, imgW, height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  offCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(offscreen, 0, 0);

  // Fade imagem → preto
  const fadeX = imgW - fadeWidth;
  const grad  = ctx.createLinearGradient(fadeX, 0, imgW, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(fadeX, 0, fadeWidth + 1, height);

  // Aspas decorativas
  ctx.font         = "italic 150px serif";
  ctx.fillStyle    = "rgba(255,255,255,0.2)";
  ctx.textBaseline = "top";
  ctx.fillText("\u201c", textX - 8, height * 0.12);

  // Texto da quote
  ctx.font         = "italic 55px serif";
  ctx.fillStyle    = "rgba(230,230,230,0.95)";
  ctx.textBaseline = "top";

  const lines  = wrapText(ctx, config.quote, textAreaW);
  const lineH  = 56;
  const blockH = lines.length * lineH + 50;
  const startY = Math.floor((height - blockH) / 2);

  for (const [i, line] of lines.entries()) {
    ctx.fillText(line, textX, startY + i * lineH);
  }

  // Separador
  const sepY = startY + lines.length * lineH + 18;
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(textX, sepY);
  ctx.lineTo(textX + 100, sepY);
  ctx.stroke();

  // Autor
  const year = new Date().getFullYear();
  ctx.font         = "36px monospace";
  ctx.fillStyle    = "rgba(160,160,160,0.9)";
  ctx.textBaseline = "top";
  ctx.fillText(`${config.author}, ${year}`, textX, sepY + 14);

  // Salvar
  const out    = createWriteStream(config.output);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  await new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); });
}

function downloadImage(picUrl, destPath) {
  return new Promise((resolve, reject) => {
    const fileStream = createWriteStream(destPath);

    const cleanup = (err) => {
      fileStream.close(() => {
        unlink(destPath).catch(() => {}).finally(() => reject(err));
      });
    };

    get(picUrl, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return cleanup(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(() => resolve()));
      fileStream.on("error", cleanup);
    }).on("error", cleanup);
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function (ctx) {
  const pfx    = ctx.config.get("CMD_PREFIX");
  const { t }  = ctx.i18n.createT(import.meta.url);
  const { msg } = ctx;

  if (!msg.is(pfx + "quote")) return;

  if (!msg.hasReply) {
    await msg.reply(t("needToReply"));
    return;
  }

  const reply        = await msg.getReply();
  const replyBody    = reply.body;
  const replyContact = await reply.getContact();
  const replyAuthor  = replyContact?.pushname ?? replyContact?.name ?? replyContact?.shortName ?? "??";
  const picUrl       = await replyContact?.getProfilePicUrl().catch(() => null);

  ctx.download.enqueue(
    async () => {
      const id         = randomUUID();
      const picPath    = join(__dirname, `pic_${id}.png`);
      const outputPath = join(__dirname, `output_${id}.png`);

      try {
        if (picUrl) await downloadImage(picUrl, picPath);

        await render({
          width:      1200,
          height:     600,
          imgPortion: 0.50,
          fadeWidth:  300,
          padding:    60,
          quote:      replyBody,
          author:     replyAuthor,
          imagePath:  picUrl ? picPath : join(__dirname, "fallback-profile.png"),
          output:     outputPath,
        });

        await ctx.sendImage(outputPath);
      } finally {
        if (picUrl) unlink(picPath).catch(console.error);
        unlink(outputPath).catch(console.error);
      }
    },
    async (err) => {
      ctx.log.error(`[quote] ${err.message}`);
      await msg.reply(t("error"));
    }
  );
}
