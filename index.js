import pkg from '@napi-rs/canvas';
const { createCanvas, loadImage, GlobalFonts } = pkg;
import { createWriteStream } from "fs";
import { unlink, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { get } from "https";
import { randomUUID, createHash } from "crypto";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Fontes ────────────────────────────────────────────────────────────────────

const FONT_DEFS = [
  { path: join(__dirname, "LiberationSerif-Regular.ttf"),    family: "QuoteSerif" },
  { path: join(__dirname, "LiberationSerif-Italic.ttf"),     family: "QuoteSerif" },
  { path: join(__dirname, "LiberationSerif-Bold.ttf"),       family: "QuoteSerif" },
  { path: join(__dirname, "LiberationSerif-BoldItalic.ttf"), family: "QuoteSerif" },
  { path: join(__dirname, "NotoColorEmoji.ttf"),             family: "QuoteEmoji" },
  // DejaVu Sans: cobertura Unicode muito mais ampla que Liberation (grego,
  // cirílico, IPA, símbolos diversos) e ainda é vetorial — não pixela.
  // Usado como fallback intermediário, e como fonte principal do autor.
  { path: join(__dirname, "DejaVuSans.ttf"),                  family: "QuoteSans"  },
  // Unifont: cobertura quase total do Unicode — último fallback para Lisu,
  // Sundanese e blocos exóticos que nem Liberation nem DejaVu cobrem.
  // AVISO: Unifont é bitmap (pixelada). Só deve ser alcançada em casos raros.
  { path: join(__dirname, "unifont.otf"),                     family: "QuoteUni"   },
];

for (const { path, family } of FONT_DEFS) {
  if (existsSync(path)) {
    const success = GlobalFonts.registerFromPath(path, family);
    if (!success) console.warn(`[quote] Falha ao registrar a fonte: ${path}`);
  } else {
    console.warn(`[quote] Arquivo de fonte não encontrado: ${path}`);
  }
}

// Stack da quote: serif → emoji colorido → sans (cobertura ampla) → unicode universal
const FONT_SERIF = `"QuoteSerif", "QuoteEmoji", "QuoteSans", "QuoteUni"`;
// Stack do autor: prioriza DejaVu Sans (cobertura ampla, vetorial, nunca pixela)
// antes de cair em Serif/Unifont — evita pixelização em nomes com acentos/símbolos
const FONT_AUTHOR = `"QuoteSans", "QuoteEmoji", "QuoteSerif", "QuoteUni"`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// ctx separado sem scale para medições — evita que scale(2) dobre os valores
// e engane o wrapText/fitFontSize
const measureCanvas = createCanvas(1, 1);
const measureCtx    = measureCanvas.getContext("2d");

function wrapText(text, maxWidth, font) {
  measureCtx.font = font;
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (measureCtx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitFontSize(text, maxWidth, maxHeight, { minSize = 14, maxSize = 60, lineSpacing = 1.4, fontTemplate }) {
  for (let size = maxSize; size >= minSize; size -= 1) {
    const font   = fontTemplate(size);
    const lines  = wrapText(text, maxWidth, font);
    const lineH  = size * lineSpacing;
    const totalH = lines.length * lineH;
    if (totalH <= maxHeight) {
      return { size, lines, lineH };
    }
  }
  const font = fontTemplate(minSize);
  return {
    size:  minSize,
    lines: wrapText(text, maxWidth, font),
    lineH: minSize * lineSpacing,
  };
}

function truncateAuthor(text, maxWidth, font) {
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && measureCtx.measureText(truncated + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "…";
}

function authorColor(author) {
  const hex = createHash("md5").update(author).digest("hex");
  const r   = parseInt(hex.slice(0, 2), 16);
  const g   = parseInt(hex.slice(2, 4), 16);
  const b   = parseInt(hex.slice(4, 6), 16);
  return [Math.floor(r * 0.28), Math.floor(g * 0.28), Math.floor(b * 0.28)];
}

function getInitial(author) {
  return author.replace(/^[\u2014\u2013\-\s]+/, "").trim()[0]?.toUpperCase() ?? "?";
}

// ── Lado esquerdo: imagem P&B ─────────────────────────────────────────────────

async function drawPhoto(ctx, imgW, height, imagePath) {
  const photo     = await loadImage(imagePath);
  const offscreen = createCanvas(imgW, height);
  const offCtx    = offscreen.getContext("2d");

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
}

// ── Lado esquerdo: placeholder ────────────────────────────────────────────────

function drawPlaceholder(ctx, imgW, height, author) {
  const [r, g, b] = authorColor(author);
  const cx = imgW / 2;
  const cy = height / 2;

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(imgW, height) * 0.75);
  grad.addColorStop(0, `rgb(${r * 3}, ${g * 3}, ${b * 3})`);
  grad.addColorStop(1, `rgb(${r}, ${g}, ${b})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, imgW, height);

  const initial  = getInitial(author);
  const fontSize = Math.floor(height * 0.65);
  ctx.font         = `bold ${fontSize}px ${FONT_SERIF}`;
  ctx.fillStyle    = "rgba(255,255,255,0.08)";
  ctx.textBaseline = "middle";
  ctx.textAlign    = "center";
  ctx.fillText(initial, cx, cy + fontSize * 0.05);

  ctx.textAlign    = "left";
  ctx.textBaseline = "top";
}

// ── Render principal ──────────────────────────────────────────────────────────

async function render(config) {
  const { width, height, imgPortion, fadeWidth, padding } = config;

  // Renderizar em 2× para texto nítido
  const SCALE  = 2;
  const canvas = createCanvas(width * SCALE, height * SCALE);
  const ctx    = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  const imgW      = Math.floor(width * imgPortion);
  const textX     = imgW + padding;
  const textAreaW = width - imgW - padding * 2;

  const AUTHOR_FONT_SIZE = 30;          // tamanho fixo, não compete com a quote
  const SEP_GAP_TOP      = 28;          // espaço entre fim da quote e o separador
  const SEP_GAP_BOTTOM   = 18;          // espaço entre separador e o autor
  const AUTHOR_H         = AUTHOR_FONT_SIZE * 1.4;
  const SEP_BLOCK_H      = SEP_GAP_TOP + 1 /* linha */ + SEP_GAP_BOTTOM;
  const QUOTE_MAX_H      = height - padding * 2 - SEP_BLOCK_H - AUTHOR_H;

  // 1. Fundo preto
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  // 2. Lado esquerdo
  const hasImage = config.imagePath && existsSync(config.imagePath);
  if (hasImage) {
    await drawPhoto(ctx, imgW, height, config.imagePath);
  } else {
    drawPlaceholder(ctx, imgW, height, config.author);
  }

  // 3. Fade → preto
  const fadeX = imgW - fadeWidth;
  const grad  = ctx.createLinearGradient(fadeX, 0, imgW, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(fadeX, 0, fadeWidth + 1, height);

  // 4. Calcular font-size adaptativo (usa measureCtx sem scale)
  const { size: quoteFontSize, lines, lineH } = fitFontSize(config.quote, textAreaW, QUOTE_MAX_H, {
    minSize:      16,
    maxSize:      72,
    lineSpacing:  1.40,
    fontTemplate: (s) => `italic ${s}px ${FONT_SERIF}`,
  });

  // Bloco total = quote + separador + autor, centralizado verticalmente
  const blockH       = lines.length * lineH;
  const totalBlockH  = blockH + SEP_BLOCK_H + AUTHOR_H;
  const startY       = Math.floor((height - totalBlockH) / 2);

  // 5. Texto da quote — offset próprio, não afeta aspas/separador/autor
  const QUOTE_TEXT_OFFSET_Y = 40; // ajuste fino só do corpo do texto

  ctx.font         = `italic ${quoteFontSize}px ${FONT_SERIF}`;
  ctx.fillStyle    = "rgba(230,230,230,0.95)";
  ctx.textBaseline = "top";

  for (const [i, line] of lines.entries()) {
    ctx.fillText(line, textX, startY + QUOTE_TEXT_OFFSET_Y + i * lineH);
  }

  // 6. Aspas decorativas — proporcionais ao tamanho real da quote
  const quoteMarkSize = Math.min(quoteFontSize * 8.2, 200);
  ctx.font         = `italic ${quoteMarkSize}px ${FONT_SERIF}`;
  ctx.fillStyle    = "rgba(255,255,255,0.12)";
  ctx.textBaseline = "top";
  // Posiciona a aspa logo acima da primeira linha, alinhada à esquerda do texto
  ctx.fillText("\u201c", textX - quoteMarkSize * 0.12, startY - quoteMarkSize * 0.30);

  // 7. Separador — agora colado ao fim real do bloco de texto
  const sepY = startY + blockH + SEP_GAP_TOP;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(textX, sepY);
  ctx.lineTo(textX + 100, sepY);
  ctx.stroke();

  // 8. Autor + ano — fonte com fallback de cobertura ampla, sem pixelizar
  const authorFont = `${AUTHOR_FONT_SIZE}px ${FONT_AUTHOR}`;
  const authorFull = `${config.author}, ${new Date().getFullYear()}`;
  const authorText = truncateAuthor(authorFull, textAreaW, authorFont);

  ctx.font         = authorFont;
  ctx.fillStyle    = "rgba(160,160,160,0.9)";
  ctx.textBaseline = "top";
  ctx.fillText(authorText, textX, sepY + SEP_GAP_BOTTOM);

  // 9. Salvar
  const buffer = await canvas.encode("png");
  await writeFile(config.output, buffer);
}

// ── Download de imagem ────────────────────────────────────────────────────────

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

// ── Handler ManyBot ───────────────────────────────────────────────────────────

export default async function (ctx) {
  const pfx    = ctx.config.get("CMD_PREFIX");
  const { t }  = ctx.i18n.createT(import.meta.url);
  const { msg } = ctx;

  if (!msg.is("quote")) return;

  if (!msg.hasReply) {
    await msg.reply.text(t("needToReply"));
    return;
  }

  const reply     = await msg.getReply();
  const replyBody = reply.body;

  // Proteção contra o erro "getAlternateUserWid"
  let replyContact = null;
  try {
    replyContact = await reply.getContact();
  } catch (err) {
    ctx.log.warn(`[quote] Falha ao obter contato: ${err.message}`);
  }

  const replyAuthor = replyContact?.pushname ?? replyContact?.name ?? replyContact?.shortName ?? "??";
  const picUrl      = await replyContact?.getProfilePicUrl().catch(() => null);

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

        await ctx.reply.image(outputPath);
      } finally {
        if (picUrl) unlink(picPath).catch(console.error);
        unlink(outputPath).catch(console.error);
      }
    },
    async (err) => {
      ctx.log.error(`[quote] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}
