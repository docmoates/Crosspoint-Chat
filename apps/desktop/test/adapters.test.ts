import { describe, expect, it } from 'vitest'
import { AnthropicEventMapper, anthropicThinkingParams, parseClaudeModel, type AnthropicRawEvent } from '../src/main/providers/anthropic'
import { CompatChunkMapper, toCatalogModel, toCompatMessages } from '../src/main/providers/openai-compat'
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

  it('reads OpenRouter catalog records', () => {
    const m = toCatalogModel(
      {
        id: 'openai/gpt-4o',
        name: 'OpenAI: GPT-4o',
        context_length: 128000,
        pricing: { prompt: '0.0000025', completion: '0.00001' },
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['tools', 'temperature']
      },
      true
    )
    expect(m).toEqual({
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      context: 128000,
      pricing: { in: 2.5, out: 10 },
      capabilities: { vision: true, tools: true, reasoning: false }
    })
    expect(toCatalogModel({ id: 'text-embedding-3-small' }, false)).toBeNull()
  })
})

describe('anthropic event mapping', () => {
  it('maps a streamed reply with thinking, text, a tool call and cache-aware cost', () => {
    const m = new AnthropicEventMapper('anthropic', 'claude-sonnet-4-6', { in: 3, out: 15 })
    const raw: AnthropicRawEvent[] = [
      { type: 'message_start', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me see.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'ping' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 500 } },
      { type: 'message_stop' }
    ]
    const events = raw.flatMap((e) => m.map(e))
    // in: 1000 fresh * 3 + 10000 cached * 3 * 0.1 + 2000 written * 3 * 1.25 = 3000 + 3000 + 7500 = 13500 / 1e6
    // out: 500 * 15 = 7500 / 1e6  => 0.021
    expect(events).toEqual([
      { type: 'thinking', delta: 'Let me see.' },
      { type: 'text', delta: 'Hi' },
      { type: 'tool_call', id: 'toolu_1', name: 'search', input: { q: 'x' } },
      { type: 'usage', usage: { provider: 'anthropic', model: 'claude-sonnet-4-6', tokensIn: 13000, tokensOut: 500, cachedTokens: 10000, costUsd: 0.021 } },
      { type: 'done', finishReason: 'tool_calls' }
    ])
    expect(m.end()).toEqual([])
  })

  it('maps max_tokens and refusal stop reasons', () => {
    const a = new AnthropicEventMapper('anthropic', 'm')
    a.map({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } })
    expect(a.end().at(-1)).toEqual({ type: 'done', finishReason: 'length' })
    const b = new AnthropicEventMapper('anthropic', 'm')
    b.map({ type: 'message_delta', delta: { stop_reason: 'refusal' } })
    expect(b.end().at(-1)).toEqual({ type: 'done', finishReason: 'refusal' })
  })

  it('chooses thinking parameters per model generation', () => {
    expect(parseClaudeModel('claude-sonnet-4-5-20250929')).toEqual({ family: 'sonnet', version: 4.5 })
    expect(parseClaudeModel('claude-3-7-sonnet-20250219')).toEqual({ family: 'sonnet', version: 3.7 })
    expect(anthropicThinkingParams('claude-opus-5-5', 'high', 32000)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      max_tokens: 32000
    })
    expect(anthropicThinkingParams('claude-opus-5-5', 'off', 32000)).toEqual({ output_config: { effort: 'low' }, max_tokens: 32000 })
    expect(anthropicThinkingParams('claude-opus-4-7', 'off', 32000)).toEqual({ max_tokens: 32000 })
    expect(anthropicThinkingParams('claude-haiku-4-5', 'medium', 4000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8192 },
      max_tokens: 8192 + 4096
    })
    expect(anthropicThinkingParams('claude-haiku-4-5', undefined, 4000)).toEqual({ max_tokens: 4000 })
  })
})
