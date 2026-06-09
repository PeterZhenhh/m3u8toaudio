import { serve } from "https://deno.land/std/http/server.ts";
import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { Readable } from "node:stream";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import M3U8Downloader from "@renmu/m3u8-downloader";

const CACHE_DIR = "./cache";
const TMP_DIR = "./tmp";

const MAX_CACHE_SIZE =
  5 * 1024 * 1024 * 1024;

await ensureDir(CACHE_DIR);
await ensureDir(TMP_DIR);

const runningTasks =
  new Map<string, Promise<void>>();

async function sha256(
  text: string,
) {
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );

  return [...new Uint8Array(digest)]
    .map((x) =>
      x
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
}

async function exists(
  path: string,
) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanupCache() {
  const files: {
    path: string;
    size: number;
    atime: number;
  }[] = [];

  let total = 0;

  for await (
    const entry of Deno.readDir(
      CACHE_DIR,
    )
  ) {
    if (!entry.isFile) {
      continue;
    }

    const path =
      `${CACHE_DIR}/${entry.name}`;

    const st =
      await Deno.stat(path);

    total += st.size;

    files.push({
      path,
      size: st.size,
      atime:
        st.atime?.getTime() ?? 0,
    });
  }

  if (
    total <= MAX_CACHE_SIZE
  ) {
    return;
  }

  files.sort(
    (a, b) =>
      a.atime - b.atime,
  );

  for (const file of files) {
    if (
      total <= MAX_CACHE_SIZE
    ) {
      break;
    }

    await Deno.remove(
      file.path,
    );

    total -= file.size;

    console.log(
      "evict",
      file.path,
    );
  }
}

async function convertToM4A(
  inputTs: string,
  outputM4A: string,
) {
  const cmd =
    new Deno.Command(
      "ffmpeg",
      {
        args: [
          "-y",

          "-i",
          inputTs,

          "-vn",

          "-c:a",
          "aac",

          "-b:a",
          "192k",

          "-movflags",
          "+faststart",

          outputM4A,
        ],

        stdout: "piped",
        stderr: "piped",
      },
    );

  const {
    code,
    stderr,
  } = await cmd.output();

  if (code !== 0) {
    throw new Error(
      new TextDecoder().decode(
        stderr,
      ),
    );
  }
}

async function buildAudio(
  m3u8Url: string,
  cacheFile: string,
  hash: string,
) {
  const tempTs =
    `${TMP_DIR}/${hash}.ts`;

  const downloader =
    new M3U8Downloader(
      m3u8Url,
      tempTs,
      {
        concurrency: 32,

        retries: 5,

        mergeSegments: true,

        convert2Mp4: false,

        clean: true,
      },
    );

  await new Promise<void>(
    (resolve, reject) => {
      downloader.on(
        "progress",
        (p) => {
          console.log(
            `${hash}: ${p.downloaded}/${p.total}`,
          );
        },
      );

      downloader.on(
        "completed",
        resolve,
      );

      downloader.on(
        "error",
        reject,
      );

      downloader.download();
    },
  );

  await convertToM4A(
    tempTs,
    cacheFile,
  );

  try {
    await Deno.remove(
      tempTs,
    );
  } catch {}

  await cleanupCache();
}

async function sendFile(
  req: Request,
  filePath: string,
) {
  const st =
    await stat(filePath);

  const size = st.size;

  const range =
    req.headers.get(
      "range",
    );

  if (!range) {
    const stream =
      Readable.toWeb(
        createReadStream(
          filePath,
        ),
      );

    return new Response(
      stream,
      {
        headers: {
          "Content-Type":
            "audio/mp4",

          "Content-Length":
            String(size),

          "Accept-Ranges":
            "bytes",
        },
      },
    );
  }

  const match =
    /^bytes=(\d+)-(\d*)$/.exec(
      range,
    );

  if (!match) {
    return new Response(
      "Invalid Range",
      {
        status: 416,
      },
    );
  }

  const start =
    Number(match[1]);

  const end = match[2]
    ? Number(match[2])
    : size - 1;

  if (
    start >= size ||
    end >= size
  ) {
    return new Response(
      "Range Not Satisfiable",
      {
        status: 416,
      },
    );
  }

  const length =
    end - start + 1;

  const stream =
    Readable.toWeb(
      createReadStream(
        filePath,
        {
          start,
          end,
        },
      ),
    );

  return new Response(
    stream,
    {
      status: 206,

      headers: {
        "Content-Type":
          "audio/mp4",

        "Content-Length":
          String(length),

        "Content-Range":
          `bytes ${start}-${end}/${size}`,

        "Accept-Ranges":
          "bytes",
      },
    },
  );
}

serve(
  async (req) => {
    try {
      const url =
        new URL(req.url);

      if (
        url.pathname !==
        "/audio"
      ) {
        return new Response(
          "Not Found",
          {
            status: 404,
          },
        );
      }

      const m3u8Url =
        url.searchParams.get(
          "url",
        );

      if (!m3u8Url) {
        return new Response(
          "missing url",
          {
            status: 400,
          },
        );
      }

      const hash =
        await sha256(
          m3u8Url,
        );

      const cacheFile =
        `${CACHE_DIR}/${hash}.m4a`;

      if (
        !(await exists(
          cacheFile,
        ))
      ) {
        let task =
          runningTasks.get(
            hash,
          );

        if (!task) {
          task =
            buildAudio(
              m3u8Url,
              cacheFile,
              hash,
            );

          runningTasks.set(
            hash,
            task,
          );

          task.finally(
            () => {
              runningTasks.delete(
                hash,
              );
            },
          );
        }

        await task;
      }

      return await sendFile(
        req,
        cacheFile,
      );
    } catch (e) {
      console.error(e);

      return new Response(
        String(e),
        {
          status: 500,
        },
      );
    }
  },
  {
    port: 8000,
  },
);

console.log(
  "http://localhost:8000/audio?url=..."
);