import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const parseUrlFromManifest = (manifest: string) => {
  if (manifest.includes('<!-- URL: ')) {
    return manifest.match(/<!-- URL: (.*) -->/)?.[1];
  }
};

export const load = async (name: string) => {
  const text = await readFile(join('./test/assets', name), 'utf8');
  const url = parseUrlFromManifest(text);
  return { text, url };
};

export const loadSync = (name: string) => readFileSync(join('./test/assets', name), 'utf8');

export const save = async (name: string, content: string) => {
  const filepath = join('./test/assets', name);
  await writeFile(join('./test/assets', name), content);
  return filepath;
};

export const downloadSegments = async (urls: string[], filepath: string) => {
  for (const url of urls) {
    const data = await fetch(url)
      .then((res) => res.arrayBuffer())
      .then((ab) => Buffer.from(ab));
    await appendFile(filepath, data);
  }
  const info = await stat(filepath);
  return info;
};
