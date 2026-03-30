export interface ParsedImageTag {
  path: string
  name: string
}

const IMAGE_TAG_RE = /\[(?:图片|image)\s*:\s*([^\]\n]+?)\s*\]/gi

function getFileName(filePath: string): string {
  const normalized = (filePath || '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || filePath
}

export function extractImageTags(raw: string): ParsedImageTag[] {
  if (!raw) return []
  const result: ParsedImageTag[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  IMAGE_TAG_RE.lastIndex = 0
  while ((match = IMAGE_TAG_RE.exec(raw)) !== null) {
    const path = (match[1] || '').trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    result.push({ path, name: getFileName(path) })
  }
  return result
}

export function stripImageTags(raw: string): string {
  if (!raw) return ''
  IMAGE_TAG_RE.lastIndex = 0
  const withoutTags = raw.replace(IMAGE_TAG_RE, '')
  const lines = withoutTags
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line) => {
      const trimmed = line.trim()
      if (/^[-*]\s*$/.test(trimmed)) return false
      return true
    })
  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseMessageContentWithImages(raw: string): {
  textContent: string
  imageTags: ParsedImageTag[]
} {
  const imageTags = extractImageTags(raw || '')
  const textContent = stripImageTags(raw || '')
  return { textContent, imageTags }
}
