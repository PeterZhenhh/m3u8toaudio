import express from "express";
import ffmpeg from "fluent-ffmpeg";
import { execFileSync } from "child_process";
import { Parser } from "m3u8-parser";

const app = express();
const durationCache = new Map();

// ======================
// WAV 参数（关键）
// ======================
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // 16bit PCM

const BYTES_PER_SEC =
  SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

// ======================
// ffprobe duration（JSON稳定版）
// ======================
function getDuration(url) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    url
  ]);

  const json = JSON.parse(out.toString());
  console.log(json);
  return parseFloat(json?.format?.duration || 0);
}

// ======================
// Range解析
// ======================
function parseRange(range) {
  if (!range) return 0;
  const m = range.match(/bytes=(\d+)-/);
  return m ? parseInt(m[1], 10) : 0;
}

// ======================
// bytes → time（WAV：完全精确）
// ======================
function bytesToTime(bytes) {
  return bytes / BYTES_PER_SEC;
}

// ======================
// WAV流接口
// ======================
app.get("/audio", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("missing url");

  const rangeHeader = req.headers.range;
  const startByte = parseRange(rangeHeader);
  const startTime = bytesToTime(startByte);

  let duration = durationCache.get(url);
  if (!duration) {
    duration = getDuration(url);
    durationCache.set(url, duration);
  }
  const totalBytes = duration * BYTES_PER_SEC;

  console.log({
    startByte,
    startTime,
    duration
  });

  // ======================
  // 206 headers
  // ======================
  res.status(206);
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");

  const endByte = Math.min(startByte + BYTES_PER_SEC * 10, totalBytes);

  res.setHeader(
    "Content-Range",
    // `bytes ${startByte}-${endByte}/${Math.floor(totalBytes)}`
    `bytes ${startByte}-${Math.floor(totalBytes) - 1}/${Math.floor(totalBytes)}`
  );

  // ======================
  // FFmpeg WAV输出
  // ======================
  const parser = new Parser();
  const m3u8Text = await (await fetch(url)).text()
  parser.push(m3u8Text);
  parser.end();
  const manifest = parser.manifest
  const segments = manifest.segments

  let startSeek = 0
  let offsetSeek = 0

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    if (startSeek + seg.duration > startTime) {
      break
    }
    startSeek += seg.duration
  }
  startSeek += 0.001
  offsetSeek = startTime - startSeek
  
  if (startByte == 0) {
    ffmpeg(url)
      .inputOptions(["-accurate_seek"])
      .seekInput(startTime)
      .format("wav")
      .audioCodec("pcm_s16le")
      .audioFrequency(SAMPLE_RATE)
      .audioChannels(CHANNELS)
      .on("start", cmd => console.log(cmd))
      .on("error", err => {
        res.end();
      })
      .pipe(res, { end: true });
  } else {
    ffmpeg(url)
      .inputOptions(["-accurate_seek"])
      .seekInput(startSeek)
      .seek(offsetSeek)
      // .format("wav")
      .format("s16le")
      .audioFrequency(SAMPLE_RATE)
      .audioChannels(CHANNELS)
      .on("start", cmd => console.log(cmd))
      .on("error", err => {
        res.end();
      })
      .pipe(res, { end: true })
  }
});

// ======================
app.listen(3000, () => {
  console.log("http://localhost:3000");
});