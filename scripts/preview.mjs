#!/usr/bin/env node

// Zero-dependency static file server for previewing the built site.
//
//   node scripts/preview.mjs [--port 8000] [--directory docs]
//
// Serves the directory at http://localhost:<port>/, maps directory requests
// to their index.html, rejects path traversal, and returns a 404 page for
// missing files.

import { createReadStream, stat } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const statAsync = promisify(stat);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
};

function usage() {
  return `Usage: node scripts/preview.mjs [options]

Serve the built Conference Atlas site over local HTTP.

Options:
  --port NUMBER       Port to listen on (default: 8000)
  --directory PATH    Directory to serve (default: docs)
  --help              Show this help`;
}

function parseArguments(argv) {
  const options = { port: 8000, directory: "docs" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (!["--port", "--directory"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (argument === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      options.port = port;
    } else {
      options.directory = value;
    }
    index += 1;
  }
  return options;
}

function sendError(response, code, title, detail) {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${code} ${title}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 4rem;">
  <h1>${code} ${title}</h1>
  <p>${detail}</p>
  <p><a href="/">Back to start</a></p>
</body>
</html>
`;
  response.writeHead(code, { "content-type": MIME_TYPES[".html"], "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function safeJoin(rootDirectory, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return { error: { code: 400, title: "Bad Request", detail: "The request path could not be decoded." } };
  }
  if (decoded.includes("\0")) {
    return { error: { code: 400, title: "Bad Request", detail: "The request path is invalid." } };
  }
  const resolved = path.resolve(rootDirectory, `.${path.posix.normalize(`/${decoded}`)}`);
  const relative = path.relative(rootDirectory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { error: { code: 403, title: "Forbidden", detail: "The request path is outside the served directory." } };
  }
  return { resolved };
}

async function resolveFile(rootDirectory, urlPath) {
  const outcome = safeJoin(rootDirectory, urlPath);
  if (outcome.error) return outcome;
  let target = outcome.resolved;
  let fileStat;
  try {
    fileStat = await statAsync(target);
  } catch {
    return { error: { code: 404, title: "Not Found", detail: `No file at ${urlPath.split("?")[0] || "/"}` } };
  }
  if (fileStat.isDirectory()) {
    target = path.join(target, "index.html");
    try {
      fileStat = await statAsync(target);
    } catch {
      return { error: { code: 404, title: "Not Found", detail: `No index.html in ${urlPath.split("?")[0] || "/"}` } };
    }
  }
  if (!fileStat.isFile()) {
    return { error: { code: 404, title: "Not Found", detail: `No file at ${urlPath.split("?")[0] || "/"}` } };
  }
  return { resolved: target, size: fileStat.size };
}

async function handleRequest(request, response, rootDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendError(response, 405, "Method Not Allowed", "Only GET and HEAD requests are supported.");
    return;
  }
  const outcome = await resolveFile(rootDirectory, request.url || "/");
  if (outcome.error) {
    sendError(response, outcome.error.code, outcome.error.title, outcome.error.detail);
    return;
  }
  const type = MIME_TYPES[path.extname(outcome.resolved).toLowerCase()] || "application/octet-stream";
  // no-cache: a preview must always reflect the latest build output, and
  // artifact freshness is handled by versioned URLs in production.
  response.writeHead(200, { "content-type": type, "content-length": outcome.size, "cache-control": "no-cache" });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(outcome.resolved);
  stream.on("error", () => sendError(response, 500, "Internal Server Error", "The file could not be read."));
  stream.pipe(response);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const rootDirectory = path.isAbsolute(options.directory) ? options.directory : path.join(ROOT, options.directory);
    const server = http.createServer((request, response) => {
      handleRequest(request, response, rootDirectory).catch(() => {
        sendError(response, 500, "Internal Server Error", "Unexpected server error.");
      });
    });
    server.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    server.listen(options.port, () => {
      console.log(`Preview: http://localhost:${options.port}/`);
      console.log(`Serving ${rootDirectory} (Ctrl+C to stop)`);
    });
  }
} catch (error) {
  console.error(error.message);
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
