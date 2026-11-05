/**
 * Picks the one thing a question is about, so only that name (never the whole question) is looked up on Wikipedia.
 * Dependency-free: runs in the renderer to decide whether to ask, and again in main to validate what it was sent.
 */

const LEADS: RegExp[] = [
  /^(?:who|what)(?:'s|\s+is|\s+was|\s+are|\s+were)\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:please\s+)?(?:tell me (?:more )?about|explain|define|describe|give me (?:an )?overview of|info(?:rmation)? (?:on|about)|learn about|what do you know about)\s+(.+)$/i
]
const TRAIL = /\s+(?:in (?:simple|plain) (?:terms|english|words)|briefly|in short|in detail|for me|please|thanks|thank you)$/i
const CHITCHAT = new Set(['hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'no', 'help', 'test', 'continue', 'go on', 'why', 'how', 'what', 'who', 'sure', 'cool', 'great', 'nice'])
const CONNECTORS = new Set(['of', 'the', 'de', 'la', 'le', 'van', 'von', 'der', 'den', 'and', 'du', 'da', 'di', 'del', 'al', 'bin', 'ibn', 'in', 'for', 'on'])
const PERSONAL = /\b(?:i|i'm|my|me|mine|you|your|we|our|us)\b/i
const MAX_CHARS = 80
const MAX_WORDS = 8

function clean(s: string): string {
  return s
    .replace(/[?!.…]+$/g, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(TRAIL, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The entity name a question is about, or null when it is not an entity question (code, chit-chat, personal or long questions). */
export function extractEntityQuery(text: string): string | null {
  const raw = String(text ?? '').trim()
  if (!raw || raw.length > 160 || raw.includes('\n') || raw.includes('```')) return null
  const line = clean(raw)
  let candidate: string | null = null
  for (const re of LEADS) {
    const m = re.exec(line)
    if (m?.[1]) {
      candidate = clean(m[1])
      break
    }
  }
  if (candidate === null) {
    // A bare name such as "Marie Curie" or "Eiffel Tower": every word capitalised (small connectors aside), at most five words.
    const words = line.split(' ').filter(Boolean)
    const proper =
      words.length >= 1 &&
      words.length <= 5 &&
      /^\p{Lu}/u.test(words[0] ?? '') &&
      words.every((w, i) => /^\p{Lu}/u.test(w) || (i > 0 && CONNECTORS.has(w.toLowerCase())) || /^\d+$/.test(w))
    if (proper) candidate = line
  }
  if (!candidate) return null
  if (candidate.length < 2 || candidate.length > MAX_CHARS) return null
  if (candidate.split(' ').length > MAX_WORDS) return null
  if (CHITCHAT.has(candidate.toLowerCase())) return null
  if (PERSONAL.test(candidate)) return null
  if (/[<>{}[\]=;]/.test(candidate)) return null
  return candidate
}
