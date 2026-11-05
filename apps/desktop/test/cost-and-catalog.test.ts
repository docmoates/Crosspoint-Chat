import { describe, expect, it } from 'vitest'
import { ANTHROPIC_CACHE, computeCost, estimateCost, perTokenToPerMillion } from '../src/main/providers/cost'
import { detectArtifacts } from '../src/main/services/artifacts'
import { cleanTitle, firstWords } from '../src/main/services/chat'

describe('cost', () => {
  it('prices fresh, cached and output tokens per million', () => {
    expect(computeCost({ in: 3, out: 15 }, { tokensIn: 1_000_000, tokensOut: 0, cachedTokens: 0 })).toBe(3)
    expect(computeCost({ in: 3, out: 15 }, { tokensIn: 0, tokensOut: 1_000_000, cachedTokens: 0 })).toBe(15)
    // half the prompt cached at 0.1x (Anthropic)
    expect(computeCost({ in: 4, out: 20 }, { tokensIn: 1_000_000, tokensOut: 0, cachedTokens: 500_000 }, ANTHROPIC_CACHE)).toBe(2.2)
  })

  it('treats unknown prices as zero and clamps nonsense', () => {
    expect(computeCost(undefined, { tokensIn: 10, tokensOut: 10, cachedTokens: 0 })).toBe(0)
    expect(computeCost({ in: null, out: 10 }, { tokensIn: 999, tokensOut: 100_000, cachedTokens: 5000 })).toBe(1)
  })

  it('estimates and converts OpenRouter per-token prices', () => {
    expect(estimateCost({ in: 2, out: 10 }, 500_000, 100_000)).toBe(2)
    expect(perTokenToPerMillion('0.000003')).toBe(3)
    expect(perTokenToPerMillion('-1')).toBeNull()
    expect(perTokenToPerMillion(undefined)).toBeNull()
  })
})

describe('artifacts', () => {
  it('detects tagged fences and named markers', () => {
    const text = [
      'Here is a page:',
      '```html',
      '<html><head><title>Clock</title></head><body>12:00</body></html>',
      '```',
      '<!-- artifact: Notes -->',
      '```python',
      'print(1)',
      '```',
      '```js',
      'console.log("not an artifact")',
      '```',
      '```mermaid',
      'graph TD; A-->B',
      '```'
    ].join('\n')
    expect(detectArtifacts(text)).toEqual([
      { name: 'Clock', kind: 'html', language: 'html', content: '<html><head><title>Clock</title></head><body>12:00</body></html>' },
      { name: 'Notes', kind: 'code', language: 'python', content: 'print(1)' },
      { name: 'Diagram', kind: 'mermaid', language: 'mermaid', content: 'graph TD; A-->B' }
    ])
  })
})

describe('titles', () => {
  it('falls back to the first words and cleans helper output', () => {
    expect(firstWords('  How do I   rotate a PDF page in Acrobat quickly? ')).toBe('How do I rotate a PDF')
    expect(cleanTitle('"Rotating PDF Pages."\nextra')).toBe('Rotating PDF Pages')
    expect(cleanTitle('Title: Trip budget')).toBe('Trip budget')
  })
})
