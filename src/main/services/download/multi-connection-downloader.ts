import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";
import { DEFAULT_DOWNLOAD_USER_AGENT } from "./js-http-downloader";
import {
  isRetryableDownloadError,
  isRetryableHttpStatus,
  parseRetryAfterMs,
} from "./js-http-downloader-helpers";

/**
 * Hydrogenium download accelerator.
 *
 * Splits a single HTTP(S) file into several byte ranges and fetches them all
 * at once over parallel connections, writing each segment straight into its
 * final offset of the destination file (sparse preallocation). Parallel
 * connections get around per-connection throughput caps that most servers and
 * CDNs impose, which makes downloads dramatically faster than a single
 * sequential stream.
 *
 * Falls back to a plain single-connection download when the server does not
 * advertise byte-range support or the file is too small to be worth splitting.
 */

export interface MultiConnectionOptions {
  url: string;
  savePath: string;
  filename?: string;
  headers?: Record<string, string>;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

const MIN_PARALLEL_FILE_SIZE = 4 * 1024 * 1024; // < 4 MiB is fine in one stream
const MIN_SEGMENT_SIZE = 1 * 1024 * 1024; // no point in 32 tiny slices
const MAX_CONNECTIONS = 8;
const SEGMENT_STALL_TIMEOUT_MS = 45_000;
const SEGMENT_MAX_RETRIES = 6;
const SEGMENT_RETRY_BASE_DELAY_MS = 750;
const SEGMENT_RETRY_MAX_DELAY_MS = 15_000;

interface ProbeResult {
  totalSize: number | null;
  acceptsRanges: boolean;
  filename: string | null;
}

interface SegmentProgress {
  start: number;
  end: number;
  received: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("Download aborted");
  err.name = "AbortError";
  return err;
}

function parseFilenameFromContentDisposition(header: string): string | null {
  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (starMatch?.[1]) {
    const rawValue = starMatch[1].trim().replace(/^["']|["']$/g, "");
    const encodedPart = rawValue.includes("''")
      ? rawValue.split("''").slice(1).join("''")
      : rawValue;
    try {
      const decoded = decodeURIComponent(encodedPart);
      const sanitized = path.basename(decoded).replaceAll(/[<>:"/\\|?*]/g, "_");
      if (sanitized) return sanitized;
    } catch {
      /* fall through to the plain form */
    }
  }

  const plainMatch = /filename\s*=\s*([^;]+)/i.exec(header);
  if (plainMatch?.[1]) {
    const rawValue = plainMatch[1].trim().replace(/^["']|["']$/g, "");
    const sanitized = path.basename(rawValue).replaceAll(/[<>:"/\\|?*]/g, "_");
    if (sanitized) return sanitized;
  }

  return null;
}

function buildHeaders(
  extraHeaders: Record<string, string>,
  range?: string
): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };

  const hasUserAgent = Object.keys(headers).some(
    (key) => key.toLowerCase() === "user-agent"
  );
  if (!hasUserAgent) headers["User-Agent"] = DEFAULT_DOWNLOAD_USER_AGENT;

  const hasAcceptEncoding = Object.keys(headers).some(
    (key) => key.toLowerCase() === "accept-encoding"
  );
  if (!hasAcceptEncoding) headers["Accept-Encoding"] = "identity";

  if (range) headers["Range"] = range;

  return headers;
}

async function probe(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<ProbeResult> {
  const result: ProbeResult = {
    totalSize: null,
    acceptsRanges: false,
    filename: null,
  };

  let response: Response | null = null;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(headers, "bytes=0-0"),
      signal,
    });
  } catch {
    /* HEAD-style probing is best-effort; fall back to GET below */
  }

  if (response?.ok || response?.status === 206) {
    const contentRange = response.headers.get("content-range");
    const rangeMatch = contentRange
      ? /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange)
      : null;

    if (rangeMatch) {
      result.acceptsRanges = true;
      result.totalSize = Number.parseInt(rangeMatch[1], 10);
    }

    const disposition = response.headers.get("content-disposition");
    if (disposition) result.filename = parseFilenameFromContentDisposition(disposition);

    if (!result.totalSize) {
      const contentLength = Number.parseInt(
        response.headers.get("content-length") ?? "0",
        10
      );
      if (Number.isFinite(contentLength) && contentLength > 0) {
        result.totalSize = contentLength;
      }
    }
  }

  try {
    response?.body?.cancel().catch(() => undefined);
  } catch {
    /* ignore */
  }

  return result;
}

function planSegments(totalSize: number): Array<{ start: number; end: number }> {
  const connectionCount = Math.min(
    MAX_CONNECTIONS,
    Math.max(1, Math.floor(totalSize / MIN_SEGMENT_SIZE))
  );

  const segments: Array<{ start: number; end: number }> = [];
  const segmentSize = Math.ceil(totalSize / connectionCount);

  for (let i = 0; i < connectionCount; i++) {
    const start = i * segmentSize;
    if (start >= totalSize) break;
    const end = Math.min(start + segmentSize - 1, totalSize - 1);
    segments.push({ start, end });
  }

  return segments;
}

async function downloadSegment(
  url: string,
  fd: number,
  segment: { start: number; end: number },
  headers: Record<string, string>,
  progress: SegmentProgress,
  onSegmentProgress: () => void,
  signal?: AbortSignal
): Promise<void> {
  let cursor = segment.start + progress.received;
  let attempt = 0;

  while (cursor <= segment.end) {
    if (signal?.aborted) throw abortError();

    try {
      const response = await fetch(url, {
        headers: buildHeaders(headers, `bytes=${cursor}-${segment.end}`),
        signal,
      });

      if (response.status === 416 && progress.received > 0) {
        // Server claims our offset is unsatisfiable; treat the tail as done.
        return;
      }

      if (!response.ok || !response.body) {
        throw Object.assign(
          new Error(`Segment request failed (HTTP ${response.status})`),
          {
            httpStatus: response.status,
            retryable: isRetryableHttpStatus(response.status),
            retryAfterMs: parseRetryAfterMs(
              response.headers.get("retry-after"),
              Date.now()
            ),
          }
        );
      }

      const reader = response.body.getReader();

      for (;;) {
        const readPromise = reader.read();
        const stallTimer = setTimeout(() => {
          reader.cancel().catch(() => undefined);
        }, SEGMENT_STALL_TIMEOUT_MS);

        let chunk: Awaited<typeof readPromise>;
        try {
          chunk = await readPromise;
        } finally {
          clearTimeout(stallTimer);
        }

        const { done, value } = chunk;
        if (done) break;

        if (value.length === 0) continue;

        fs.writeSync(fd, value, 0, value.length, cursor);
        cursor += value.length;
        progress.received += value.length;
        onSegmentProgress();

        if (cursor > segment.end) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }

      return;
    } catch (err) {
      const error = err as Error & {
        retryable?: boolean;
        httpStatus?: number;
        retryAfterMs?: number | null;
      };

      if (signal?.aborted || error.name === "AbortError") throw abortError();

      const retryable =
        error.retryable === true || isRetryableDownloadError(error);

      if (!retryable || attempt >= SEGMENT_MAX_RETRIES) throw error;

      attempt += 1;
      const delay = Math.min(
        SEGMENT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        SEGMENT_RETRY_MAX_DELAY_MS
      );
      const waitMs =
        error.httpStatus === 429 && error.retryAfterMs != null
          ? Math.min(error.retryAfterMs, SEGMENT_RETRY_MAX_DELAY_MS)
          : delay;

      logger.log(
        `[HydrogeniumAccelerator] Segment ${segment.start}-${segment.end} ` +
          `retry ${attempt}/${SEGMENT_MAX_RETRIES} in ${waitMs}ms: ${error.message}`
      );
      await sleep(waitMs, signal);
      cursor = segment.start + progress.received;
    }
  }
}

async function singleConnectionFallback(
  options: MultiConnectionOptions,
  filePath: string
): Promise<void> {
  const { url, headers = {}, signal } = options;

  const existingSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const rangeHeaders = buildHeaders(
    headers,
    existingSize > 0 ? `bytes=${existingSize}-` : undefined
  );

  const response = await fetch(url, { headers: rangeHeaders, signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }

  const writeStream = fs.createWriteStream(filePath, {
    flags: existingSize > 0 ? "a" : "w",
  });

  try {
    const reader = response.body.getReader();
    let downloaded = existingSize;
    const totalSize =
      Number.parseInt(response.headers.get("content-length") ?? "0", 10) +
      downloaded;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!writeStream.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => writeStream.once("drain", resolve));
      }
      downloaded += value.length;
      options.onProgress?.(downloaded, totalSize);
    }
  } finally {
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.once("finish", resolve);
      writeStream.once("error", reject);
    });
  }
}

export async function acceleratedDownload(
  options: MultiConnectionOptions
): Promise<void> {
  const { url, savePath, filename, headers = {}, onProgress, signal } = options;

  if (!fs.existsSync(savePath)) fs.mkdirSync(savePath, { recursive: true });

  const resolvedName =
    filename ||
    path.basename(new URL(url).pathname) ||
    "hydrogenium-download";
  const filePath = path.join(savePath, resolvedName);

  const info = await probe(url, headers, signal);
  const totalSize = info.totalSize ?? 0;

  if (!info.acceptsRanges || totalSize < MIN_PARALLEL_FILE_SIZE) {
    logger.log(
      `[HydrogeniumAccelerator] Single-stream mode ` +
        `(ranges=${info.acceptsRanges}, size=${totalSize})`
    );
    await singleConnectionFallback(options, filePath);
    return;
  }

  logger.log(
    `[HydrogeniumAccelerator] Accelerating download of ${resolvedName} ` +
      `(${totalSize} bytes) over parallel connections`
  );

  // Preallocate the sparse destination so every segment can write directly at
  // its final offset without intermediate merge files.
  const existingComplete =
    fs.existsSync(filePath) && fs.statSync(filePath).size === totalSize;

  if (existingComplete) {
    onProgress?.(totalSize, totalSize);
    return;
  }

  const fd = fs.openSync(filePath, "w");
  try {
    fs.ftruncateSync(fd, totalSize);

    const segments = planSegments(totalSize);
    const trackers: SegmentProgress[] = segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      received: 0,
    }));

    let lastReportedAt = 0;
    const reportProgress = () => {
      const now = Date.now();
      if (now - lastReportedAt < 500) return;
      lastReportedAt = now;
      const downloaded = trackers.reduce((sum, t) => sum + t.received, 0);
      onProgress?.(downloaded, totalSize);
    };

    await Promise.all(
      segments.map((segment, index) =>
        downloadSegment(
          url,
          fd,
          segment,
          headers,
          trackers[index],
          reportProgress,
          signal
        )
      )
    );

    onProgress?.(totalSize, totalSize);
  } finally {
    fs.closeSync(fd);
  }
}
