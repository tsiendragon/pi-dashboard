import { TTS_CHUNK_CHARS } from './ttsSettings'

/**
 * Turn a markdown reply into something worth listening to: no code blocks,
 * link targets, tables, or raw markup artifacts.
 */
export function toSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '（代码块已省略）')
    .replace(/~~~[\s\S]*?~~~/g, '（代码块已省略）')
    .replace(/`[^`\n]+`/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/https?:\/\/[^\s，。！？、；：）】」]+/g, '链接')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split text into speech-sized chunks on sentence boundaries.
 *
 * DashScope's non-realtime synthesis latency grows with the text (≈5s for 300
 * chars, >100s for 1500), so a long reply is read chunk by chunk instead of
 * forcing the listener to wait for the whole thing.
 */
export function splitForSpeech(text: string, maxChars = TTS_CHUNK_CHARS): string[] {
  const normalized = text.trim()
  if (!normalized) return []
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }
  for (const sentence of normalized.split(/(?<=[。！？!?；;.\n])/u)) {
    if (sentence.length > maxChars) {
      flush()
      for (let start = 0; start < sentence.length; start += maxChars) {
        const piece = sentence.slice(start, start + maxChars).trim()
        if (piece) chunks.push(piece)
      }
      continue
    }
    if (current.length + sentence.length > maxChars) flush()
    current += sentence
  }
  flush()
  return chunks
}