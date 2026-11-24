#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_ROOT_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'MAINTAINER.md',
  'ROADMAP.md',
];

function collectMarkdownFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectMarkdownFiles(fullPath));
      } else if (entry.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist in some contexts
  }
  return results;
}

const allFiles = [...DOCS_ROOT_FILES, ...collectMarkdownFiles('docs')];
const HOST_PATTERN = /https?:\/\/[a-zA-Z0-9.-]+(?:\.onrender\.com|\.vercel\.app)[^\s)\]">]*/g;

const foundUrls = new Set();
for (const file of allFiles) {
  try {
    const content = readFileSync(file, 'utf8');
    let match;
    while ((match = HOST_PATTERN.exec(content)) !== null) {
      const cleanUrl = match[0].replace(/[`'".,;:)<>]+$/, '');
      foundUrls.add(cleanUrl);
    }
  } catch {
    // Skip if file doesn't exist
  }
}

if (foundUrls.size === 0) {
  console.log('No project host URLs (*.onrender.com, *.vercel.app) found in documentation.');
  process.exit(0);
}

console.log(`Checking ${foundUrls.size} project host URLs for availability and suspended status...`);

let hasFailure = false;
const failures = [];

for (const url of foundUrls) {
  process.stdout.write(`Checking ${url}... `);
  try {
    const controller = new AbortController();
    // Allow up to 60s for cold starts on free hosts
    const timeout = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Quay-Link-Checker/1.0',
      },
    });
    clearTimeout(timeout);

    const body = await res.text();
    if (res.status >= 500) {
      console.log(`FAIL (HTTP ${res.status})`);
      failures.push({ url, reason: `HTTP ${res.status}` });
      hasFailure = true;
    } else if (body.includes('Service Suspended')) {
      console.log(`FAIL (Service Suspended body)`);
      failures.push({ url, reason: 'Body contains "Service Suspended"' });
      hasFailure = true;
    } else {
      console.log(`OK (HTTP ${res.status})`);
    }
  } catch (err) {
    console.log(`FAIL (${err.message})`);
    failures.push({ url, reason: err.message });
    hasFailure = true;
  }
}

if (hasFailure) {
  console.error('\nSuspended or unreachable project hosts detected:');
  for (const f of failures) {
    console.error(`  - ${f.url}: ${f.reason}`);
  }
  process.exit(1);
} else {
  console.log('\nAll project hosts are healthy.');
}
