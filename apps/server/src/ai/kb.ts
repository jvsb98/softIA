/**
 * Base de conhecimento (RAG): ingestão de documentos, FAQ e páginas do site, com busca
 * híbrida — textual em português (sempre) + vetorial (quando pgvector e embeddings existem).
 */
import { capabilities, one, q } from '../lib/db.js'
import { enqueue, every, work, type Job } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { runEmbedding } from './router.js'
import { safeFetch } from '../lib/net-guard.js'

// ---------------------------------------------------------------- extração de texto

export async function extractText(buf: Buffer, mime: string, filename = ''): Promise<string> {
  const lower = filename.toLowerCase()
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    const { extractText: pdf, getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(new Uint8Array(buf))
    const { text } = await pdf(doc, { mergePages: false })
    return (Array.isArray(text) ? text : [text]).join('\n\n')
  }
  if (mime.includes('officedocument.wordprocessingml') || lower.endsWith('.docx')) {
    const mammoth = await import('mammoth')
    const r = await mammoth.extractRawText({ buffer: buf })
    return r.value
  }
  if (mime.includes('html') || lower.endsWith('.html') || lower.endsWith('.htm')) return htmlToText(buf.toString('utf8'))
  return buf.toString('utf8')
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `\n\n## ${inner.replace(/<[^>]+>/g, ' ').trim()}\n\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/section)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Divide em trechos de ~900 caracteres respeitando títulos e parágrafos, com sobreposição curta. */
export function chunkText(text: string, size = 900, overlap = 120): { heading: string | null; content: string }[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim()
  const sections: { heading: string | null; body: string }[] = []
  let current = { heading: null as string | null, body: '' }
  for (const line of clean.split('\n')) {
    // Título: markdown (#) ou linha curta toda em maiúsculas (comum em PDFs)
    const t = line.trim()
    const md = t.match(/^#{1,6}\s+(.+)$/)
    const caps = !md && t.length >= 4 && t.length < 90 && /[A-ZÀ-Ý]/.test(t) && t === t.toUpperCase() && !/[.!?]$/.test(t)
    const h = md ? md[1] : caps ? t : null
    if (h) {
      if (current.body.trim()) sections.push(current)
      current = { heading: h.trim(), body: '' }
    } else current.body += line + '\n'
  }
  if (current.body.trim()) sections.push(current)

  const out: { heading: string | null; content: string }[] = []
  for (const s of sections) {
    const paras = s.body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
    let buf = ''
    for (const p of paras) {
      if ((buf + ' ' + p).length > size && buf) {
        out.push({ heading: s.heading, content: buf.trim() })
        buf = buf.slice(-overlap) + ' ' + p
      } else buf = buf ? `${buf}\n${p}` : p
      while (buf.length > size * 1.6) {
        out.push({ heading: s.heading, content: buf.slice(0, size).trim() })
        buf = buf.slice(size - overlap)
      }
    }
    if (buf.trim()) out.push({ heading: s.heading, content: buf.trim() })
  }
  return out.filter((c) => c.content.length > 20)
}

// ---------------------------------------------------------------- indexação

export async function indexDocument(documentId: string) {
  const doc = await one<any>(`SELECT * FROM kb_documents WHERE id=$1`, [documentId])
  if (!doc) return
  await q(`UPDATE kb_documents SET status='processing', error=NULL WHERE id=$1`, [documentId])
  try {
    let text: string = doc.raw_text ?? ''
    if (doc.source === 'site' && doc.url) {
      text = await fetchSite(doc.url)
      await q(`UPDATE kb_documents SET raw_text=$2, last_fetched_at=now() WHERE id=$1`, [documentId, text])
    }
    const chunks = chunkText(text)
    await q(`DELETE FROM kb_chunks WHERE document_id=$1`, [documentId])
    for (let i = 0; i < chunks.length; i++) {
      await q(`INSERT INTO kb_chunks(document_id, idx, heading, content) VALUES ($1,$2,$3,$4)`, [documentId, i, chunks[i]!.heading, chunks[i]!.content])
    }
    // Embeddings (opcional)
    if (capabilities.vector && chunks.length) {
      const rows = await q<{ id: number; heading: string | null; content: string }>(`SELECT id, heading, content FROM kb_chunks WHERE document_id=$1 ORDER BY idx`, [documentId])
      for (let i = 0; i < rows.length; i += 64) {
        const batch = rows.slice(i, i + 64)
        const e = await runEmbedding(batch.map((r) => `${r.heading ?? ''}\n${r.content}`))
        if (!e) break
        for (let j = 0; j < batch.length; j++) {
          await q(`UPDATE kb_chunks SET embedding=$2::vector, embedding_model=$3 WHERE id=$1`, [batch[j]!.id, `[${e.vectors[j]!.join(',')}]`, e.model])
        }
      }
    }
    await q(`UPDATE kb_documents SET status='ready', chars=$2, chunks=$3, updated_at=now() WHERE id=$1`, [documentId, text.length, chunks.length])
    log().info({ documentId, chunks: chunks.length }, 'Documento indexado na base de conhecimento')
  } catch (err: any) {
    await q(`UPDATE kb_documents SET status='error', error=$2 WHERE id=$1`, [documentId, String(err?.message ?? err).slice(0, 500)])
    throw err
  }
}

async function fetchSite(url: string): Promise<string> {
  const res = await safeFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; KnowledgeBot/1.0)' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Site respondeu ${res.status}`)
  const html = await res.text()
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  return `${title ? `# ${title}\n\n` : ''}${htmlToText(html)}`
}

// ---------------------------------------------------------------- busca

export interface KbHit {
  source: 'faq' | 'doc'
  title: string
  content: string
  score: number
  id: string
}

/** Busca híbrida. Retorna FAQ (prioridade) e trechos de documentos mais relevantes. */
export async function searchKb(query: string, limit = 5): Promise<KbHit[]> {
  const text = query.trim().slice(0, 500)
  if (!text) return []
  const faq = await q<any>(
    `SELECT id, question, answer, ts_rank_cd(tsv, websearch_to_tsquery('portuguese', na_norm($1))) AS rank
       FROM faq_entries
      WHERE active AND tsv @@ websearch_to_tsquery('portuguese', na_norm($1))
      ORDER BY rank DESC LIMIT 3`,
    [text],
  ).catch(() => [])
  // Busca textual "OR" (tolerante: qualquer termo relevante)
  const orQuery = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 16)
    .join(' or ')
  const docs = orQuery
    ? await q<any>(
        `SELECT c.id, c.heading, c.content, d.title, ts_rank_cd(c.tsv, websearch_to_tsquery('portuguese', na_norm($1))) AS rank
           FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id
          WHERE d.active AND d.status='ready' AND c.tsv @@ websearch_to_tsquery('portuguese', na_norm($1))
          ORDER BY rank DESC LIMIT $2`,
        [orQuery, limit * 2],
      ).catch(() => [])
    : []
  let vectorHits: any[] = []
  if (capabilities.vector) {
    const e = await runEmbedding([text]).catch(() => null)
    if (e) {
      vectorHits = await q<any>(
        `SELECT c.id, c.heading, c.content, d.title, 1 - (c.embedding <=> $1::vector) AS sim
           FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id
          WHERE d.active AND d.status='ready' AND c.embedding IS NOT NULL AND c.embedding_model=$2
          ORDER BY c.embedding <=> $1::vector LIMIT $3`,
        [`[${e.vectors[0]!.join(',')}]`, e.model, limit * 2],
      ).catch(() => [])
    }
  }
  // Fusão por posição (Reciprocal Rank Fusion)
  const scores = new Map<string, { hit: KbHit; s: number }>()
  const add = (list: any[], weight: number) =>
    list.forEach((r, i) => {
      const key = `doc:${r.id}`
      const prev = scores.get(key)
      const s = weight / (60 + i)
      if (prev) prev.s += s
      else scores.set(key, { hit: { source: 'doc', id: String(r.id), title: r.heading ? `${r.title} — ${r.heading}` : r.title, content: r.content, score: 0 }, s })
    })
  add(docs, 1)
  add(vectorHits.filter((v) => v.sim > 0.25), 1.2)
  const merged = [...scores.values()].sort((a, b) => b.s - a.s).slice(0, limit).map((x) => ({ ...x.hit, score: Number(x.s.toFixed(4)) }))
  return [
    ...faq.map((f: any) => ({ source: 'faq' as const, id: f.id, title: f.question, content: f.answer, score: Number(f.rank) })),
    ...merged,
  ].slice(0, limit + 2)
}

export function formatKbContext(hits: KbHit[]): string {
  if (!hits.length) return '<conhecimento>\n(nenhum trecho relevante encontrado)\n</conhecimento>'
  return `<conhecimento>\n${hits.map((h, i) => `### [${i + 1}] ${h.source === 'faq' ? 'Pergunta frequente: ' : ''}${h.title}\n${h.content}`).join('\n\n')}\n</conhecimento>`
}

// ---------------------------------------------------------------- workers

export function registerKbWorkers() {
  work('kb.index', async (job: Job<{ documentId: string }>) => indexDocument(job.payload.documentId), 1)
  work(
    'kb.refresh',
    async () => {
      const due = await q<{ id: string }>(
        `SELECT id FROM kb_documents WHERE source='site' AND active AND refresh_days IS NOT NULL
           AND (last_fetched_at IS NULL OR last_fetched_at < now() - (refresh_days || ' days')::interval)`,
      )
      for (const d of due) await enqueue('kb.index', { documentId: d.id }, { singletonKey: `kb:${d.id}`, mode: 'keep' })
    },
    1,
  )
  every(60 * 60 * 1000, 'kb.refresh')
}
