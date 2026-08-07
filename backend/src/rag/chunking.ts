export interface TextSegment {
  readonly content: string;
  readonly section?: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface TextChunk extends TextSegment {
  readonly sequence: number;
  readonly characterCount: number;
  readonly contentChecksum: string;
}

export interface ChunkerOptions {
  readonly targetCharacters: number;
  readonly overlapCharacters: number;
  readonly maxChunks: number;
}

function normalizeText(input: string): string {
  return Array.from(input)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

import { createHash } from 'node:crypto';

export function chunkText(input: string, options: ChunkerOptions): TextChunk[] {
  if (options.overlapCharacters >= options.targetCharacters) {
    throw new Error('overlapCharacters must be smaller than targetCharacters');
  }
  const text = normalizeText(input);
  if (!text) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let sequence = 0;
  const step = options.targetCharacters - options.overlapCharacters;

  while (start < text.length) {
    if (chunks.length >= options.maxChunks) {
      throw new Error(`Document exceeds the maximum of ${options.maxChunks} chunks`);
    }
    const hardEnd = Math.min(start + options.targetCharacters, text.length);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const boundary = text.lastIndexOf('\n', hardEnd);
      const space = text.lastIndexOf(' ', hardEnd);
      const candidate = Math.max(boundary, space);
      if (candidate > start + Math.floor(options.targetCharacters * 0.6)) end = candidate;
    }
    const content = text.slice(start, end).trim();
    if (content) {
      const contentStart = text.indexOf(content, start);
      const contentEnd = contentStart + content.length;
      chunks.push({
        sequence,
        content,
        sourceStart: contentStart,
        sourceEnd: contentEnd,
        characterCount: content.length,
        contentChecksum: checksum(content),
      });
      sequence += 1;
    }
    if (end >= text.length) break;
    start = Math.max(start + step, end - options.overlapCharacters);
  }
  return chunks;
}

export function normalizeSourceText(input: string, mimeType: string): string {
  if (mimeType === 'text/html') {
    return normalizeText(
      input
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&'),
    );
  }
  return normalizeText(input);
}
