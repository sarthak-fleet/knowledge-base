export interface ChunkingOptions {
  size?: number;
  overlap?: number;
}

export function chunkText(text: string, options: ChunkingOptions = {}): string[] {
  const size = Math.max(100, Math.min(options.size ?? 2000, 8000));
  const overlap = Math.max(0, Math.min(options.overlap ?? 200, size - 1));
  const chunks: string[] = [];
  if (!text) return chunks;

  const paragraphs = text.split('\n\n');
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length <= size) {
      currentChunk += `${currentChunk ? '\n\n' : ''}${paragraph}`;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    if (paragraph.length > size) {
      let remaining = paragraph;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, size);
        chunks.push(chunk);
        remaining = remaining.slice(size - overlap);
        if (remaining.length <= overlap) break;
      }
    } else {
      currentChunk = paragraph;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}
