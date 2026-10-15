import type { LiveSessionDetail } from '../../shared/src/live-sessions.js'
import type { SupervisorSessionDigest } from '../../shared/src/supervisor.js'

/**
 * Deterministic, non-authoritative digest of a session's recent assistant output.
 *
 * The supervisor page used to print the raw transcript tail, which is written for the model, not for
 * a reader. This module only rewrites that same evidence into a headline, a few points and the two
 * questions a reader actually asks ("在等什么" / "下一步"), never inventing facts: everything is a
 * verbatim excerpt of recent assistant text, and the caller keeps the raw tail available.
 */

const MAX_MESSAGES = 8
const MAX_POINTS = 3
const MAX_SENTENCE = 160
const MIN_SENTENCE = 6

/** Spoken-style lead-ins the agent uses when talking to a colleague, not content. */
const SPEECH_PREFIX = /^(?:喵+|好的?|收到|嗯|明白|好)[，,!！。:：]?\s*/u
const MARKDOWN = /^\s*(?:[-*>#]+|\d+[.)])\s*/
const NOISE_LINE = [
  /^\s*(?:cd|npm|npx|node|python3?|git|curl|wget|bash|rg|grep|ls|cat|sed|tmux|mkdir|rm)\b/i,
  /^\s*\|/, // markdown tables
  /^\s*(?:https?|file):\/\//i,
  /^\s*(?:```|---|\*\*\*)/,
  /^Background Command\b/i,
  /^extension ui notify/i,
  /^\/[\w.-]+(?:\/[\w.-]+)*[,:\s]/, // lines starting with an absolute path
]
const WAITING = /待确认|需要你|等你|请你|请确认|是否要|要不要|由你决定|待你|确认后再|等你确认|你怎么看|需要我|要我/
const NEXT_STEP = /下一步|接下来|后续|剩余|待办|未完成|还没|尚未|剩下|todo/i
const RESULT = /已完成|完成|已修复|已更新|已提交|已通过|通过|成功|符合预期|exit=0|结论|总结/i
const PROBLEM = /失败|报错|错误|阻塞|超时|无法|不能|不可用|回退|风险/
/** "当前没有待处理的后续" mentions waiting words while denying them; it is not an open question. */
const NEGATED = /^(?:当前|目前|现在)?(?:没有|无|不存在|未发现|还没有)/

function clean(line: string): string {
  return line
    .replace(MARKDOWN, '')
    .replace(/\*\*|__/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(SPEECH_PREFIX, '')
    .trim()
}

/** Splits one message into readable sentences, dropping commands, paths, tables and code blocks. */
export function sentences(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, '\n')
  const out: string[] = []
  for (const rawLine of plain.split('\n')) {
    const line = clean(rawLine)
    if (!line || NOISE_LINE.some(pattern => pattern.test(line))) continue
    for (const piece of line.split(/(?<=[。！？；!?;])/u)) {
      const sentence = piece.trim()
      if (sentence.length < MIN_SENTENCE) continue
      out.push(sentence.length > MAX_SENTENCE ? sentence.slice(0, MAX_SENTENCE) + '…' : sentence)
    }
  }
  return out
}

interface Turn { role?: string; text: string }

function turns(detail?: LiveSessionDetail): Turn[] {
  const found: Turn[] = []
  for (const entry of detail?.entries || []) {
    const message = (entry as { message?: { role?: string; content?: unknown } }).message
    if (!message || (message.role !== 'assistant' && message.role !== 'user')) continue
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter(part => (part as { type?: string }).type === 'text').map(part => String((part as { text?: string }).text || '')).join('\n')
        : ''
    if (!text.trim()) continue
    found.push({ role: message.role, text })
  }
  return found
}

function normalize(sentence: string): string {
  return sentence.replace(/[\s，,。.、：:；;！!？?「」【】()（）]/g, '').toLowerCase()
}

/** Character-bigram overlap: catches points that only repeat an earlier one in different words. */
function similar(a: string, b: string): boolean {
  const grams = (value: string) => {
    const text = normalize(value)
    const set = new Set<string>()
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
    return set
  }
  const left = grams(a), right = grams(b)
  if (!left.size || !right.size) return false
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared++
  return shared / Math.min(left.size, right.size) >= 0.6
}

function first(sentences: string[], pattern: RegExp): string | undefined {
  return sentences.find(sentence => pattern.test(sentence))
}

/** Newest-first, de-duplicated sentences of the recent window, plus the per-message view. */
export function digestSession(detail?: LiveSessionDetail): SupervisorSessionDigest | undefined {
  const recent = turns(detail).filter(turn => turn.role === 'assistant').slice(-MAX_MESSAGES)
  if (!recent.length) return undefined
  const perMessage = recent.map(turn => sentences(turn.text)).filter(list => list.length > 0)
  if (!perMessage.length) return undefined
  const all = perMessage.flat()
  const newestFirst = [...perMessage].reverse().flat()

  const waitingFor = first(newestFirst.filter(sentence => !NEGATED.test(sentence)), WAITING)
  const nextStep = first(all.filter(sentence => !NEGATED.test(sentence)), NEXT_STEP)
  // Headline prefers a result or problem statement in the newest message; otherwise its first line.
  const headline = first(perMessage[perMessage.length - 1], RESULT) || first(perMessage[perMessage.length - 1], PROBLEM) || perMessage[perMessage.length - 1][0]
  const seen = new Set(headline ? [normalize(headline)] : [])
  const points: string[] = []
  // Signal-bearing sentences first (results, problems, follow-ups), then plain narration.
  const ranked = [...newestFirst.filter(sentence => RESULT.test(sentence) || PROBLEM.test(sentence) || NEXT_STEP.test(sentence)), ...newestFirst]
  for (const sentence of ranked) {
    if (points.length >= MAX_POINTS) break
    const key = normalize(sentence)
    if (seen.has(key)) continue
    if (waitingFor && key === normalize(waitingFor)) continue
    if (nextStep && key === normalize(nextStep)) continue
    if (points.some(kept => similar(kept, sentence))) continue
    seen.add(key)
    points.push(sentence)
  }
  if (!headline && !points.length && !waitingFor && !nextStep) return undefined
  return { headline, points, waitingFor, nextStep: nextStep === waitingFor ? undefined : nextStep, coveredMessages: recent.length, source: 'recent_output' }
}