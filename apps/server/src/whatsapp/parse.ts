/**
 * Converte uma mensagem do Baileys num formato simples para o atendimento.
 */
import { getContentType, normalizeMessageContent, type WAMessage, type proto } from '@whiskeysockets/baileys'

export interface ParsedMessage {
  kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact' | 'reaction' | 'unsupported' | 'protocol'
  body: string | null
  hasMedia: boolean
  mime?: string
  filename?: string
  quotedWaId?: string | null
  reactionTo?: string | null
  isPtt?: boolean
  selectedOptionId?: string | null
}

export function parseMessage(msg: WAMessage): ParsedMessage {
  const content = normalizeMessageContent(msg.message)
  if (!content) return { kind: 'unsupported', body: null, hasMedia: false }
  const type = getContentType(content)
  const ctx: proto.IContextInfo | null | undefined = (content as any)[type as string]?.contextInfo
  const quotedWaId = ctx?.stanzaId ?? null

  switch (type) {
    case 'conversation':
      return { kind: 'text', body: content.conversation ?? '', hasMedia: false }
    case 'extendedTextMessage':
      return { kind: 'text', body: content.extendedTextMessage?.text ?? '', hasMedia: false, quotedWaId }
    case 'imageMessage':
      return { kind: 'image', body: content.imageMessage?.caption ?? null, hasMedia: true, mime: content.imageMessage?.mimetype ?? 'image/jpeg', quotedWaId }
    case 'videoMessage':
      return { kind: 'video', body: content.videoMessage?.caption ?? null, hasMedia: true, mime: content.videoMessage?.mimetype ?? 'video/mp4', quotedWaId }
    case 'audioMessage':
      return {
        kind: 'audio',
        body: null,
        hasMedia: true,
        mime: content.audioMessage?.mimetype ?? 'audio/ogg',
        isPtt: !!content.audioMessage?.ptt,
        quotedWaId,
      }
    case 'documentMessage':
      return {
        kind: 'document',
        body: content.documentMessage?.caption ?? null,
        hasMedia: true,
        mime: content.documentMessage?.mimetype ?? 'application/octet-stream',
        filename: content.documentMessage?.fileName ?? 'documento',
        quotedWaId,
      }
    case 'documentWithCaptionMessage': {
      const d = content.documentWithCaptionMessage?.message?.documentMessage
      return { kind: 'document', body: d?.caption ?? null, hasMedia: true, mime: d?.mimetype ?? 'application/octet-stream', filename: d?.fileName ?? 'documento' }
    }
    case 'stickerMessage':
      return { kind: 'sticker', body: null, hasMedia: true, mime: content.stickerMessage?.mimetype ?? 'image/webp' }
    case 'locationMessage': {
      const l = content.locationMessage
      return { kind: 'location', body: `${l?.name ? l.name + ' — ' : ''}https://maps.google.com/?q=${l?.degreesLatitude},${l?.degreesLongitude}`, hasMedia: false }
    }
    case 'liveLocationMessage': {
      const l = content.liveLocationMessage
      return { kind: 'location', body: `Localização em tempo real: https://maps.google.com/?q=${l?.degreesLatitude},${l?.degreesLongitude}`, hasMedia: false }
    }
    case 'contactMessage':
      return { kind: 'contact', body: content.contactMessage?.displayName ?? 'Contato', hasMedia: false }
    case 'contactsArrayMessage':
      return { kind: 'contact', body: (content.contactsArrayMessage?.contacts ?? []).map((c) => c.displayName).join(', '), hasMedia: false }
    case 'reactionMessage':
      return { kind: 'reaction', body: content.reactionMessage?.text ?? '', hasMedia: false, reactionTo: content.reactionMessage?.key?.id ?? null }
    case 'buttonsResponseMessage':
      return {
        kind: 'text',
        body: content.buttonsResponseMessage?.selectedDisplayText ?? '',
        hasMedia: false,
        selectedOptionId: content.buttonsResponseMessage?.selectedButtonId ?? null,
      }
    case 'listResponseMessage':
      return {
        kind: 'text',
        body: content.listResponseMessage?.title ?? '',
        hasMedia: false,
        selectedOptionId: content.listResponseMessage?.singleSelectReply?.selectedRowId ?? null,
      }
    case 'templateButtonReplyMessage':
      return {
        kind: 'text',
        body: content.templateButtonReplyMessage?.selectedDisplayText ?? '',
        hasMedia: false,
        selectedOptionId: content.templateButtonReplyMessage?.selectedId ?? null,
      }
    case 'protocolMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo':
      return { kind: 'protocol', body: null, hasMedia: false }
    default:
      return { kind: 'unsupported', body: `[mensagem do tipo ${type ?? 'desconhecido'} — abra no celular]`, hasMedia: false }
  }
}

export function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  }
  return map[mime.split(';')[0]!.trim()] ?? 'bin'
}
