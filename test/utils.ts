import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Input, UrlSource } from '../src';

export const assetPath = (name: string) => path.resolve('./test/assets', name);
export const assetFileUrl = (name: string) => pathToFileURL(assetPath(name)).toString();

export const parseUrlFromManifest = (manifest: string) =>
  manifest.match(/<!--\s*URL:\s*([^\n]+?)\s*-->/)?.[1]?.trim();

export const loadAsset = async (name: string) => {
  const text = await readFile(assetPath(name), 'utf8').then((data) => data.trim());
  const originalUrl = parseUrlFromManifest(text);
  return { text, originalUrl };
};

export const loadAssetSync = (name: string) => readFileSync(assetPath(name), 'utf8');

export const createAssetInput = (name: string, formats: readonly unknown[]) =>
  new Input({
    source: new UrlSource(assetFileUrl(name)),
    formats: formats as never,
  });

export const save = async (name: string, content: string) => {
  const filepath = assetPath(name);
  await writeFile(filepath, content);
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
