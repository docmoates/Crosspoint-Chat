import { describe, expect, it } from 'vitest'
import { CompatChunkMapper, toCompatMessages } from '../src/main/providers/openai-compat'
import type { ProviderStreamEvent } from '../src/main/providers/types'

describe('openai-compat chunk mapping', () => {
  it('maps text, reasoning, tool calls and OpenRouter-reported cost', () => {
    const m = new CompatChunkMapper('openrouter', 'anthropic/claude-sonnet-4.5', { in: 3, out: 15 })
    const events: ProviderStreamEvent[] = [
      ...m.map({ choices: [{ delta: { reasoning: 'thinking...' } }] }),
      ...m.map({ choices: [{ delta: { content: 'Hel' } }] }),
      ...m.map({ choices: [{ delta: { content: 'lo' } }] }),
      ...m.map({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_', arguments: '{"q":' } }] } }] }),
      ...m.map({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: '"Paris"}' } }] }, finish_reason: 'tool_calls' }] }),
      ...m.map({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.00123 } }),
      ...m.end()
    ]
    expect(events).toEqual([
      { type: 'thinking', delta: 'thinking...' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { q: 'Paris' } },
      {
        type: 'usage',
        usage: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tokensIn: 100, tokensOut: 20, cachedTokens: 40, costUsd: 0.00123 }
      },
      { type: 'done', finishReason: 'tool_calls' }
    ])
  })

  it('computes cost from catalog pricing when the server does not report it', () => {
    const m = new CompatChunkMapper('openai', 'gpt-4o', { in: 2.5, out: 10 })
    m.map({ choices: [{ delta: { reasoning_content: 'r' }, finish_reason: 'length' }], usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 } })
    const end = m.end()
    expect(end[0]).toMatchObject({ type: 'usage', usage: { costUsd: 3.5 } })
    expect(end[1]).toEqual({ type: 'done', finishReason: 'length' })
  })

  it('emits only done when no usage arrives', () => {
    expect(new CompatChunkMapper('x', 'y').end()).toEqual([{ type: 'done', finishReason: 'stop' }])
  })

  it('builds vision parts as data URLs and puts system first', () => {
    const msgs = toCompatMessages(
      [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', mime: 'image/png', base64: 'AAAA' }] }],
      'be brief'
    )
    expect(msgs[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(msgs[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    })
  })
})
