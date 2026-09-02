#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node scripts/configure.mjs [--config PATH]

Apply conference title and locale metadata to the static shell.

Options:
  --config PATH  Configuration file (default: config/conference.json)
  --help         Show this help`;
}

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  if (!argv.length) return { config: "config/conference.json" };
  if (argv.length !== 2 || argv[0] !== "--config") throw new Error(`Invalid arguments: ${argv.join(" ")}`);
  return { config: argv[1] };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const configPath = path.isAbsolute(options.config) ? options.config : path.join(ROOT, options.config);
    const configuration = JSON.parse(await readFile(configPath, "utf8"));
    for (const key of ["name", "atlas_title", "locale", "repository"]) {
      if (!String(configuration[key] || "").trim()) throw new Error(`Missing config key: ${key}`);
    }
    const indexPath = path.join(ROOT, "docs", "index.html");
    let html = await readFile(indexPath, "utf8");
    html = html
      .replace(/<html lang="[^"]+">/u, `<html lang="${configuration.locale}">`)
      .replace(/<title>[^<]+<\/title>/u, `<title>${configuration.atlas_title}</title>`)
      .replace(/<h1>[^<]+<\/h1>/u, `<h1>${configuration.atlas_title}</h1>`)
      .replace(/aria-label="[^"]* material browser"/u, `aria-label="${configuration.name} material browser"`);
    await writeFile(indexPath, html, "utf8");
    console.log(`Configured ${configuration.atlas_title} (${configuration.locale})`);
  }
} catch (error) {
  console.error(error.message);
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
