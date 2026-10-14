// Sends a file with HTTP Range support, which browsers need to seek inside a video.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

export async function sendFile(request: FastifyRequest, reply: FastifyReply, file: string, contentType: string) {
  const size = (await stat(file)).size;
  reply.header("Content-Type", contentType).header("Accept-Ranges", "bytes").header("Cache-Control", "no-cache");

  const range = request.headers.range;
  if (!range) {
    reply.header("Content-Length", size);
    return reply.send(createReadStream(file));
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = NaN;
  let end = NaN;
  if (m && m[1] !== "") {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== "") {
    // "bytes=-500" means the last 500 bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (!(start <= end && start < size)) {
    return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  }
  reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
  return reply.send(createReadStream(file, { start, end }));
}
