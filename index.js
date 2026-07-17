import pkg from '@napi-rs/canvas';
const { createCanvas, loadImage, GlobalFonts } = pkg;
import { unlink, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID, createHash } from "crypto";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Fonts ─────────────────────────────────────────────────────────────────────

const FONT_DEFS = [
  { path: join(__dirname, "LiberationSerif-Regular.ttf"),    family: "QuoteSerif" },
  { path: join(__dirname, "LiberationSerif-Italic.ttf"),     family: "QuoteSerif" },
  { path: join(__dirname, "LiberationSerif-Bold.ttf"),       family: "QuoteSerif" },
  { path: join(__dirname, "LiberationSerif-BoldItalic.ttf"), family: "QuoteSerif" },
  { path: join(__dirname, "NotoColorEmoji.ttf"),             family: "QuoteEmoji" },
  // DejaVu Sans: much wider Unicode coverage than Liberation (Greek, Cyrillic,
  // IPA, misc symbols) and still vector — no pixelation.
  // Used as intermediate fallback and as the primary font for author names.
  { path: join(__dirname, "DejaVuSans.ttf"),                  family: "QuoteSans"  },
  // Unifont: near-complete Unicode coverage — last-resort fallback for Lisu,
  // Sundanese, and exotic blocks not covered by Liberation or DejaVu.
  // WARNING: Unifont is bitmap (pixelated). Should only be reached in rare cases.
  { path: join(__dirname, "unifont.otf"),                     family: "QuoteUni"   },
  { path: join(__dirname, "STIXTwoMath-Regular.ttf"),         family: "QuoteMath"  },
  { path: join(__dirname, "NotoSansBamum-Regular.ttf"),       family: "QuoteBamum"  },
];

for (const { path, family } of FONT_DEFS) {
  if (existsSync(path)) {
    const success = GlobalFonts.registerFromPath(path, family);
    if (!success) console.warn(`[quote] Failed to register font: ${path}`);
  } else {
    console.warn(`[quote] Font file not found: ${path}`);
  }
}

// Stack for quote body: serif -> color emoji -> broad-coverage sans -> math/script -> unicode fallback
const FONT_SERIF = `"QuoteSerif", "QuoteEmoji", "QuoteSans", "QuoteMath", "QuoteBamum", "QuoteUni"`;
// Stack for author name: DejaVu Sans first (wide coverage, vector, never pixelates)
// before falling back to Serif/Unifont — avoids pixelation on accented/symbolic names
const FONT_AUTHOR = `"QuoteSans", "QuoteEmoji", "QuoteSerif", "QuoteMath", "QuoteBamum", "QuoteUni"`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Separate unscaled canvas for text measurements — prevents scale(2) from doubling
// measured values and throwing off wrapText/fitFontSize calculations
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

// ── Left side: grayscale photo ────────────────────────────────────────────────

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

// ── Left side: placeholder ───────────────────────────────────────────────────

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

// ── Render ────────────────────────────────────────────────────────────────────

async function render(config) {
  const { width, height, imgPortion, fadeWidth, padding } = config;

  // Render at 2x for sharp text
  const SCALE  = 2;
  const canvas = createCanvas(width * SCALE, height * SCALE);
  const ctx    = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  const imgW      = Math.floor(width * imgPortion);
  const textX     = imgW + padding;
  const textAreaW = width - imgW - padding * 2;

  const AUTHOR_FONT_SIZE = 30;          // fixed size — doesn't compete with quote body
  const SEP_GAP_TOP      = 28;          // gap between end of quote block and separator
  const SEP_GAP_BOTTOM   = 18;          // gap between separator and author line
  const AUTHOR_H         = AUTHOR_FONT_SIZE * 1.4;
  const SEP_BLOCK_H      = SEP_GAP_TOP + 1 /* linha */ + SEP_GAP_BOTTOM;
  const QUOTE_MAX_H      = height - padding * 2 - SEP_BLOCK_H - AUTHOR_H;

  // 1. Black background
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  // 2. Left side
  const hasImage = config.imagePath && existsSync(config.imagePath);
  if (hasImage) {
    await drawPhoto(ctx, imgW, height, config.imagePath);
  } else {
    drawPlaceholder(ctx, imgW, height, config.author);
  }

  // 3. Fade to black
  const fadeX = imgW - fadeWidth;
  const grad  = ctx.createLinearGradient(fadeX, 0, imgW, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(fadeX, 0, fadeWidth + 1, height);

  // 4. Adaptive font size (uses unscaled measureCtx)
  const { size: quoteFontSize, lines, lineH } = fitFontSize(config.quote, textAreaW, QUOTE_MAX_H, {
    minSize:      16,
    maxSize:      72,
    lineSpacing:  1.40,
    fontTemplate: (s) => `italic ${s}px ${FONT_SERIF}`,
  });

  // Total block = quote + separator + author, centered vertically
  const blockH       = lines.length * lineH;
  const totalBlockH  = blockH + SEP_BLOCK_H + AUTHOR_H;
  const startY       = Math.floor((height - totalBlockH) / 2);

  // 5. Quote text — independent Y offset, does not affect marks/separator/author
  const QUOTE_TEXT_OFFSET_Y = 40;

  ctx.font         = `italic ${quoteFontSize}px ${FONT_SERIF}`;
  ctx.fillStyle    = "rgba(230,230,230,0.95)";
  ctx.textBaseline = "top";

  for (const [i, line] of lines.entries()) {
    ctx.fillText(line, textX, startY + QUOTE_TEXT_OFFSET_Y + i * lineH);
  }

  // 6. Decorative quotation mark — scaled proportionally to the quote font size
  const quoteMarkSize = Math.min(quoteFontSize * 8.2, 200);
  ctx.font         = `italic ${quoteMarkSize}px ${FONT_SERIF}`;
  ctx.fillStyle    = "rgba(255,255,255,0.12)";
  ctx.textBaseline = "top";
  // Position just above the first line, left-aligned with the text block
  ctx.fillText("\u201c", textX - quoteMarkSize * 0.12, startY - quoteMarkSize * 0.30);

  // 7. Separator — anchored to the end of the text block
  const sepY = startY + blockH + SEP_GAP_TOP;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(textX, sepY);
  ctx.lineTo(textX + 100, sepY);
  ctx.stroke();

  // 8. Author + year — broad-coverage font stack, never pixelates
  const authorFont = `${AUTHOR_FONT_SIZE}px ${FONT_AUTHOR}`;
  const authorFull = `${config.author}, ${new Date().getFullYear()}`;
  const authorText = truncateAuthor(authorFull, textAreaW, authorFont);

  ctx.font         = authorFont;
  ctx.fillStyle    = "rgba(160,160,160,0.9)";
  ctx.textBaseline = "top";
  ctx.fillText(authorText, textX, sepY + SEP_GAP_BOTTOM);

  // 9. Save
  const buffer = await canvas.encode("png");
  await writeFile(config.output, buffer);
}

// ── ManyBot handler ───────────────────────────────────────────────────────────

export default async function (ctx) {
  const { t }   = ctx.i18n.createT(import.meta.url);
  const { msg } = ctx;

  if (!msg.is("quote")) return;

  if (!msg.hasReply) {
    await msg.reply.text(t("needToReply"));
    return;
  }

  const reply       = await msg.getReply();
  const replyBody   = reply.body;
  const replySender = reply.sender; // resolved JID — always available, even for @lid contacts

  // ctx.contacts.get() merges raw + store-resolved contact records and can
  // still return null for a contact never seen before (e.g. unresolved @lid).
  // That's fine for the *name* — but the profile picture doesn't need contact
  // confirmation at all, so contactId uses replySender directly and isn't
  // gated behind this lookup succeeding.
  const replyContact = await ctx.contacts.get(replySender).catch(() => null);

  const replyAuthor = replyContact?.pushname ?? replyContact?.name ?? replySender.split("@")[0] ?? "??";
  const contactId   = replySender || null;

  ctx.download.enqueue(
    async () => {
      const id         = randomUUID();
      const picPath    = ctx.storage.resolve(`pic_${id}.png`);
      const outputPath = ctx.storage.resolve(`output_${id}.png`);
      let   hasPic     = false;
      let   hasOutput  = false;

      try {
        if (contactId) {
          hasPic = !!(await ctx.contacts.getPfpPath(contactId, picPath).catch(() => null));
        }

        await render({
          width:      1200,
          height:     600,
          imgPortion: 0.50,
          fadeWidth:  300,
          padding:    60,
          quote:      replyBody,
          author:     replyAuthor,
          imagePath:  hasPic ? picPath : join(__dirname, "fallback-profile.png"),
          output:     outputPath,
        });

        hasOutput = true;
        await msg.reply.image(outputPath);
      } finally {
        if (hasPic)    unlink(picPath).catch(console.error);
        if (hasOutput) unlink(outputPath).catch(console.error);
      }
    },
    async (err) => {
      ctx.log.error(`[quote] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}
