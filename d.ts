const durationCache = new Map<string, number>();

// ======================
// WAV 参数
// ======================

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

const BYTES_PER_SEC =
  SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

// ======================
// ffprobe duration
// ======================

async function getDuration(url: string): Promise<number> {
  const cmd = new Deno.Command("ffprobe", {
    args: [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      url,
    ],
    stdout: "piped",
  });

  const { stdout } = await cmd.output();

  const json = JSON.parse(
    new TextDecoder().decode(stdout),
  );

  console.log(json);

  return parseFloat(json?.format?.duration || "0");
}

// ======================
// Range解析
// ======================

function parseRange(range: string | null): number {
  if (!range) return 0;

  const m = range.match(/bytes=(\d+)-/);

  return m ? parseInt(m[1], 10) : 0;
}

// ======================
// bytes -> time
// ======================

function bytesToTime(bytes: number): number {
  return bytes / BYTES_PER_SEC;
}

// ======================
// HTTP
// ======================

Deno.serve({ port: 3000 }, async (req) => {
  const urlObj = new URL(req.url);

  if (urlObj.pathname !== "/audio") {
    return new Response("Not Found", {
      status: 404,
    });
  }

  const sourceUrl = urlObj.searchParams.get("url");

  if (!sourceUrl) {
    return new Response("missing url", {
      status: 400,
    });
  }

  const rangeHeader = req.headers.get("range");

  const startByte = parseRange(rangeHeader);

  const startTime = bytesToTime(startByte);

  let duration = durationCache.get(sourceUrl);

  if (!duration) {
    duration = await getDuration(sourceUrl);
    durationCache.set(sourceUrl, duration);
  }

  const totalBytes = duration * BYTES_PER_SEC;

  console.log({
    startByte,
    startTime,
    duration,
  });

  const endByte = Math.min(
    startByte + BYTES_PER_SEC * 10,
    totalBytes,
  );

  // ======================
  // ffmpeg
  // ======================

  const ffmpeg = new Deno.Command("ffmpeg", {
    args: [
      "-ss",
      String(startTime),
      "-i",
      sourceUrl,

      "-f",
      "wav",

      "-acodec",
      "pcm_s16le",

      "-ar",
      String(SAMPLE_RATE),

      "-ac",
      String(CHANNELS),

      "-",
    ],

    stdout: "piped",
    stderr: "piped",
  });

  const child = ffmpeg.spawn();

  child.stderr
    .pipeTo(Deno.stderr.writable)
    .catch(() => {});

  return new Response(child.stdout, {
    status: 206,

    headers: {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",

      "Content-Range":
        `bytes ${startByte}-${Math.floor(endByte)}/${Math.floor(totalBytes)}`,
    },
  });
});

console.log("http://localhost:3000");