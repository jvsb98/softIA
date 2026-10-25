/**
 * Provedores de IA chamados por HTTP direto (sem SDKs), com uma interface única:
 * chat com ferramentas (tool calling), transcrição de áudio e embeddings.
 *
 * Cada adaptador conduz o próprio laço de ferramentas para preservar o formato
 * nativo das mensagens do provedor entre as rodadas.
 */
import { decryptSecret } from '../lib/crypto.js'
import { safeFetch } from '../lib/net-guard.js'

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'openai_compatible' | 'mock'

export interface ProviderRow {
  id: string
  name: string
  kind: ProviderKind
  api_key_enc: string | null
  base_url: string | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any> // JSON Schema (type: object)
}

export interface ChatRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  onTool?: (name: string, args: any) => Promise<any>
  maxToolRounds?: number
  maxTokens?: number
  temperature?: number
  json?: boolean
  timeoutMs?: number
  /** dica para o provedor simulado */
  mockHint?: string
}

export interface ToolCallRecord {
  name: string
  args: any
  result: any
}

export interface ChatResult {
  text: string
  toolCalls: ToolCallRecord[]
  usage: { input: number; output: number }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message)
  }
}

async function http(url: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 45_000)
  try {
    const res = await safeFetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || (typeof data === 'string' ? data.slice(0, 300) : `HTTP ${res.status}`)
      throw new ProviderError(`${res.status}: ${msg}`, res.status, res.status === 429 || res.status >= 500)
    }
    return data
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new ProviderError('Tempo de resposta do provedor esgotado', 408)
    throw err
  } finally {
    clearTimeout(t)
  }
}

const key = (p: ProviderRow) => {
  const k = decryptSecret(p.api_key_enc)
  if (!k && p.kind !== 'mock' && p.kind !== 'openai_compatible') throw new ProviderError(`Provedor "${p.name}" sem chave de API`, 401, false)
  return k
}

// ======================================================================= Anthropic

async function anthropicChat(p: ProviderRow, r: ChatRequest): Promise<ChatResult> {
  const base = (p.base_url || 'https://api.anthropic.com').replace(/\/$/, '')
  const headers = { 'content-type': 'application/json', 'x-api-key': key(p), 'anthropic-version': '2023-06-01' }
  const messages: any[] = r.messages.map((m) => ({ role: m.role, content: m.content }))
  const tools = r.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  const usage = { input: 0, output: 0 }
  const toolCalls: ToolCallRecord[] = []
  for (let round = 0; round <= (r.maxToolRounds ?? 4); round++) {
    const data = await http(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      timeoutMs: r.timeoutMs,
      body: JSON.stringify({
        model: r.model,
        system: r.system,
        messages,
        max_tokens: r.maxTokens ?? 1024,
        temperature: r.temperature,
        ...(tools?.length ? { tools } : {}),
      }),
    })
    usage.input += data.usage?.input_tokens ?? 0
    usage.output += data.usage?.output_tokens ?? 0
    const blocks: any[] = data.content ?? []
    const uses = blocks.filter((b) => b.type === 'tool_use')
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!uses.length || !r.onTool || data.stop_reason !== 'tool_use') return { text, toolCalls, usage }
    messages.push({ role: 'assistant', content: blocks })
    const results: any[] = []
    for (const u of uses) {
      const result = await safeTool(r, u.name, u.input)
      toolCalls.push({ name: u.name, args: u.input, result })
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) })
    }
    messages.push({ role: 'user', content: results })
  }
  return { text: '', toolCalls, usage }
}

// ======================================================================= OpenAI (e compatíveis)

async function openaiChat(p: ProviderRow, r: ChatRequest): Promise<ChatResult> {
  const base = (p.base_url || 'https://api.openai.com/v1').replace(/\/$/, '')
  const k = key(p)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (k) headers.authorization = `Bearer ${k}`
  const messages: any[] = [{ role: 'system', content: r.system }, ...r.messages]
  const tools = r.tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  const usage = { input: 0, output: 0 }
  const toolCalls: ToolCallRecord[] = []
  for (let round = 0; round <= (r.maxToolRounds ?? 4); round++) {
    const data = await http(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      timeoutMs: r.timeoutMs,
      body: JSON.stringify({
        model: r.model,
        messages,
        max_completion_tokens: r.maxTokens ?? 1024,
        ...(r.temperature !== undefined && !/^(o\d|gpt-5)/.test(r.model) ? { temperature: r.temperature } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(r.json && !tools?.length ? { response_format: { type: 'json_object' } } : {}),
      }),
    })
    usage.input += data.usage?.prompt_tokens ?? 0
    usage.output += data.usage?.completion_tokens ?? 0
    const msg = data.choices?.[0]?.message ?? {}
    const calls: any[] = msg.tool_calls ?? []
    if (!calls.length || !r.onTool) return { text: (msg.content ?? '').trim(), toolCalls, usage }
    messages.push(msg)
    for (const c of calls) {
      let args: any = {}
      try {
        args = JSON.parse(c.function?.arguments || '{}')
      } catch {
        args = {}
      }
      const result = await safeTool(r, c.function?.name, args)
      toolCalls.push({ name: c.function?.name, args, result })
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
    }
  }
  return { text: '', toolCalls, usage }
}

// ======================================================================= Google Gemini

/** O Gemini aceita um subconjunto de JSON Schema: removemos campos não suportados. */
function geminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(geminiSchema)
  if (!s || typeof s !== 'object') return s
  const out: any = {}
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', '$schema', 'default', 'examples'].includes(k)) continue
    out[k] = geminiSchema(v)
  }
  return out
}

async function geminiChat(p: ProviderRow, r: ChatRequest): Promise<ChatResult> {
  const base = (p.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
  const url = `${base}/models/${encodeURIComponent(r.model)}:generateContent`
  const contents: any[] = r.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const tools = r.tools?.length ? [{ functionDeclarations: r.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }] : undefined
  const usage = { input: 0, output: 0 }
  const toolCalls: ToolCallRecord[] = []
  for (let round = 0; round <= (r.maxToolRounds ?? 4); round++) {
    const data = await http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key(p) },
      timeoutMs: r.timeoutMs,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: r.system }] },
        contents,
        ...(tools ? { tools } : {}),
        generationConfig: {
          maxOutputTokens: r.maxTokens ?? 1024,
          temperature: r.temperature,
          ...(r.json && !tools ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    })
    usage.input += data.usageMetadata?.promptTokenCount ?? 0
    usage.output += data.usageMetadata?.candidatesTokenCount ?? 0
    const parts: any[] = data.candidates?.[0]?.content?.parts ?? []
    const calls = parts.filter((x) => x.functionCall)
    const text = parts
      .filter((x) => typeof x.text === 'string' && !x.thought)
      .map((x) => x.text)
      .join('\n')
      .trim()
    if (!calls.length || !r.onTool) return { text, toolCalls, usage }
    contents.push({ role: 'model', parts })
    const responses: any[] = []
    for (const c of calls) {
      const result = await safeTool(r, c.functionCall.name, c.functionCall.args ?? {})
      toolCalls.push({ name: c.functionCall.name, args: c.functionCall.args ?? {}, result })
      responses.push({ functionResponse: { name: c.functionCall.name, response: { result } } })
    }
    contents.push({ role: 'user', parts: responses })
  }
  return { text: '', toolCalls, usage }
}

async function safeTool(r: ChatRequest, name: string, args: any) {
  try {
    return await r.onTool!(name, args ?? {})
  } catch (err: any) {
    return { erro: String(err?.message ?? err) }
  }
}

// ======================================================================= dispatch

export async function chat(p: ProviderRow, r: ChatRequest): Promise<ChatResult> {
  switch (p.kind) {
    case 'anthropic':
      return anthropicChat(p, r)
    case 'openai':
    case 'openai_compatible':
      return openaiChat(p, r)
    case 'gemini':
      return geminiChat(p, r)
    case 'mock': {
      const { mockChat } = await import('./mock.js')
      return mockChat(r)
    }
  }
}

export async function transcribe(p: ProviderRow, model: string, audio: Buffer, mime: string): Promise<string> {
  if (p.kind === 'openai' || p.kind === 'openai_compatible') {
    const base = (p.base_url || 'https://api.openai.com/v1').replace(/\/$/, '')
    const form = new FormData()
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'webm'
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] }), `audio.${ext}`)
    form.append('model', model || 'whisper-1')
    form.append('language', 'pt')
    const k = key(p)
    const data = await http(`${base}/audio/transcriptions`, { method: 'POST', headers: k ? { authorization: `Bearer ${k}` } : {}, body: form, timeoutMs: 90_000 })
    return String(data?.text ?? '').trim()
  }
  if (p.kind === 'gemini') {
    const r = await http(
      `${(p.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key(p) },
        timeoutMs: 90_000,
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ inline_data: { mime_type: mime.split(';')[0], data: audio.toString('base64') } }, { text: 'Transcreva este áudio em português do Brasil, literalmente, sem comentários.' }],
            },
          ],
        }),
      },
    )
    return (r.candidates?.[0]?.content?.parts ?? [])
      .map((x: any) => x.text ?? '')
      .join(' ')
      .trim()
  }
  if (p.kind === 'mock') return '[transcrição simulada — configure um provedor com transcrição (OpenAI ou Gemini)]'
  throw new ProviderError(`O provedor ${p.kind} não oferece transcrição de áudio`, 400, false)
}

export async function embed(p: ProviderRow, model: string, texts: string[]): Promise<number[][]> {
  if (p.kind === 'openai' || p.kind === 'openai_compatible') {
    const base = (p.base_url || 'https://api.openai.com/v1').replace(/\/$/, '')
    const k = key(p)
    const data = await http(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) },
      body: JSON.stringify({ model: model || 'text-embedding-3-small', input: texts }),
    })
    return (data.data ?? []).map((d: any) => d.embedding)
  }
  if (p.kind === 'gemini') {
    const m = model || 'gemini-embedding-001'
    const data = await http(`${(p.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${m}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key(p) },
      body: JSON.stringify({ requests: texts.map((t) => ({ model: `models/${m}`, content: { parts: [{ text: t }] } })) }),
    })
    return (data.embeddings ?? []).map((e: any) => e.values)
  }
  throw new ProviderError(`O provedor ${p.kind} não gera embeddings`, 400, false)
}

/** Teste rápido de conexão usado pelo painel. */
export async function ping(p: ProviderRow, model: string): Promise<string> {
  const r = await chat(p, { model, system: 'Responda apenas com a palavra OK.', messages: [{ role: 'user', content: 'Teste de conexão.' }], maxTokens: 20, temperature: 0, timeoutMs: 20_000 })
  return r.text || '(resposta vazia)'
}

export function parseJsonLoose<T = any>(text: string): T | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}
