import PDFDocument from 'pdfkit'
import { marked, type Token, type Tokens } from 'marked'

// Render a Jara AI answer (Markdown) as a clean A4 PDF with pdfkit's built-in
// fonts. Those fonts only cover Windows-1252, so text is sanitised first.

const C = { ink: '#0b1f16', forest: '#0f3d2a', mandarin: '#ff6b00', crest: '#ffc72c', muted: '#5b6b63', line: '#d9d2c3', cream: '#fff6e5' }
const F = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique', mono: 'Courier' }
const M = { left: 56, right: 56, top: 64, bottom: 72 }

const WIN1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''))
function clean(s: string): string {
  return s
    .replace(/₦\s?/g, 'NGN ')
    .replace(/[≈]/g, '~')
    .replace(/[≤]/g, '<=')
    .replace(/[≥]/g, '>=')
    .replace(/[→⇒]/g, '->')
    .replace(/[✓✔✅]/g, '[x]')
    .replace(/[   ]/g, ' ')
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN1252_EXTRA.has(ch)
    })
    .join('')
}

interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  mono?: boolean
}

function inlineRuns(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  if (!tokens) return []
  const out: Run[] = []
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
        out.push(...inlineRuns((t as Tokens.Strong).tokens, { ...style, bold: true }))
        break
      case 'em':
        out.push(...inlineRuns((t as Tokens.Em).tokens, { ...style, italic: true }))
        break
      case 'codespan':
        out.push({ ...style, mono: true, text: (t as Tokens.Codespan).text })
        break
      case 'link': {
        const l = t as Tokens.Link
        out.push(...inlineRuns(l.tokens, style))
        break
      }
      case 'br':
        out.push({ ...style, text: '\n' })
        break
      case 'del':
        out.push(...inlineRuns((t as Tokens.Del).tokens, style))
        break
      case 'text': {
        const tt = t as Tokens.Text
        if (tt.tokens?.length) out.push(...inlineRuns(tt.tokens, style))
        else out.push({ ...style, text: decode(tt.text) })
        break
      }
      case 'escape':
        out.push({ ...style, text: (t as Tokens.Escape).text })
        break
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ ...style, text: decode(t.text) })
    }
  }
  return out
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const fontFor = (r: Run) => (r.mono ? F.mono : r.bold && r.italic ? F.boldItalic : r.bold ? F.bold : r.italic ? F.italic : F.regular)
const plain = (runs: Run[]) => runs.map((r) => r.text).join('')

export async function renderAnswerPdf(opts: { markdown: string; kind: string; question: string; date: Date; author?: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: `Jara AI - ${opts.kind}`, Author: 'Jara AI', Creator: 'usejara.xyz' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

  const width = doc.page.width - M.left - M.right
  const bottom = () => doc.page.height - M.bottom
  const ensure = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage()
  }

  const writeRuns = (runs: Run[], o: { size: number; color?: string; indent?: number; lineGap?: number; width?: number }) => {
    const parts = runs.map((r) => ({ ...r, text: clean(r.text) })).filter((r) => r.text.length)
    if (!parts.length) return
    const x = M.left + (o.indent ?? 0)
    const w = o.width ?? width - (o.indent ?? 0)
    doc.fillColor(o.color ?? C.ink).fontSize(o.size)
    parts.forEach((r, i) => {
      doc.font(fontFor(r))
      const last = i === parts.length - 1
      if (i === 0) doc.text(r.text, x, doc.y, { width: w, continued: !last, lineGap: o.lineGap ?? 3 })
      else doc.text(r.text, { continued: !last, lineGap: o.lineGap ?? 3 })
    })
  }

  // ── Header band ──────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 44).fill(C.forest)
  doc.roundedRect(M.left, 12, 20, 20, 4).fill(C.crest)
  doc.fillColor(C.ink).font(F.bold).fontSize(12).text('J', M.left + 6.5, 16.5)
  doc.fillColor(C.cream).font(F.bold).fontSize(13).text('Jara AI', M.left + 28, 15.5)
  doc.fillColor(C.crest).font(F.bold).fontSize(9).text(clean(opts.kind.toUpperCase()), M.left, 18, { width, align: 'right' })
  doc.y = M.top

  // Meta line
  const meta = [opts.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), opts.author ? `Prepared for ${opts.author}` : null].filter(Boolean).join('  |  ')
  doc.fillColor(C.muted).font(F.regular).fontSize(9).text(clean(meta), M.left, doc.y, { width })
  doc.moveDown(0.8)

  // Question box
  if (opts.question) {
    const q = clean(opts.question.length > 600 ? `${opts.question.slice(0, 597)}...` : opts.question)
    doc.font(F.regular).fontSize(10)
    const h = doc.heightOfString(q, { width: width - 28 }) + 30
    ensure(h)
    const y = doc.y
    doc.roundedRect(M.left, y, width, h, 6).fill(C.cream)
    doc.rect(M.left, y, 4, h).fill(C.mandarin)
    doc.fillColor(C.muted).font(F.bold).fontSize(8).text('QUESTION', M.left + 16, y + 9)
    doc.fillColor(C.ink).font(F.regular).fontSize(10).text(q, M.left + 16, y + 21, { width: width - 28 })
    doc.y = y + h + 16
  }

  // ── Body ─────────────────────────────────────────────────────
  const tokens = marked.lexer(opts.markdown)

  const renderList = (list: Tokens.List, level: number) => {
    list.items.forEach((item, i) => {
      const indent = 14 + level * 16
      const bullet = list.ordered ? `${Number(list.start || 1) + i}.` : level ? '-' : '•'
      ensure(18)
      const y = doc.y
      doc.fillColor(level ? C.muted : C.mandarin).font(F.bold).fontSize(10.5).text(bullet, M.left + indent - 14, y, { width: 14 })
      doc.y = y
      const inline: Run[] = []
      const nested: Tokens.List[] = []
      for (const t of item.tokens) {
        if (t.type === 'list') nested.push(t as Tokens.List)
        else if (t.type === 'text' || t.type === 'paragraph') inline.push(...inlineRuns((t as Tokens.Text).tokens ?? [{ type: 'text', raw: t.raw, text: (t as Tokens.Text).text } as Tokens.Text]))
      }
      writeRuns(inline, { size: 10.5, indent })
      doc.moveDown(0.25)
      nested.forEach((n) => renderList(n, level + 1))
    })
  }

  const renderTable = (t: Tokens.Table) => {
    const cols = t.header.length
    const colW = width / cols
    const pad = 5
    const cellH = (runs: Run[], bold: boolean) => {
      doc.font(bold ? F.bold : F.regular).fontSize(9)
      return doc.heightOfString(clean(plain(runs)) || ' ', { width: colW - pad * 2 }) + pad * 2
    }
    const row = (cells: Run[][], header: boolean) => {
      const h = Math.max(...cells.map((c) => cellH(c, header)))
      ensure(h)
      const y = doc.y
      if (header) doc.rect(M.left, y, width, h).fill(C.forest)
      cells.forEach((c, i) => {
        doc.fillColor(header ? C.cream : C.ink).font(header ? F.bold : F.regular).fontSize(9)
        doc.text(clean(plain(c)), M.left + i * colW + pad, y + pad, { width: colW - pad * 2 })
      })
      doc.moveTo(M.left, y + h).lineTo(M.left + width, y + h).lineWidth(0.5).strokeColor(C.line).stroke()
      doc.y = y + h
    }
    row(t.header.map((c) => inlineRuns(c.tokens)), true)
    t.rows.forEach((r) => row(r.map((c) => inlineRuns(c.tokens)), false))
    doc.moveDown(0.8)
  }

  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading
        const size = h.depth === 1 ? 20 : h.depth === 2 ? 14 : 12
        // Keep a heading with at least a few lines of what follows it.
        ensure(size * 2 + 60)
        doc.moveDown(h.depth === 1 ? 0.2 : 0.6)
        writeRuns(inlineRuns(h.tokens).map((r) => ({ ...r, bold: true })), { size, color: h.depth === 1 ? C.ink : C.forest, lineGap: 2 })
        if (h.depth === 1) {
          doc.moveDown(0.3)
          doc.moveTo(M.left, doc.y).lineTo(M.left + 60, doc.y).lineWidth(3).strokeColor(C.mandarin).stroke()
          doc.moveDown(0.6)
        } else doc.moveDown(0.35)
        break
      }
      case 'paragraph':
        ensure(30)
        writeRuns(inlineRuns((t as Tokens.Paragraph).tokens), { size: 10.5 })
        doc.moveDown(0.7)
        break
      case 'list':
        renderList(t as Tokens.List, 0)
        doc.moveDown(0.4)
        break
      case 'table':
        renderTable(t as Tokens.Table)
        break
      case 'blockquote': {
        const runs = (t as Tokens.Blockquote).tokens.flatMap((x) => inlineRuns((x as Tokens.Paragraph).tokens ?? []))
        ensure(30)
        const y = doc.y
        writeRuns(runs.map((r) => ({ ...r, italic: true })), { size: 10.5, indent: 14, color: C.muted })
        doc.rect(M.left, y, 3, doc.y - y).fill(C.crest)
        doc.moveDown(0.7)
        break
      }
      case 'code': {
        const text = clean((t as Tokens.Code).text)
        doc.font(F.mono).fontSize(9)
        const h = doc.heightOfString(text, { width: width - 20 }) + 16
        ensure(Math.min(h, 200))
        const y = doc.y
        doc.rect(M.left, y, width, h).fill('#f3efe6')
        doc.fillColor(C.ink).font(F.mono).fontSize(9).text(text, M.left + 10, y + 8, { width: width - 20 })
        doc.y = y + h + 10
        break
      }
      case 'hr':
        ensure(20)
        doc.moveDown(0.4)
        doc.moveTo(M.left, doc.y).lineTo(M.left + width, doc.y).lineWidth(0.5).strokeColor(C.line).stroke()
        doc.moveDown(0.8)
        break
      default:
        break
    }
  }

  // ── Footer on every page ─────────────────────────────────────
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    // Writing inside the bottom margin makes pdfkit add a page; lift the margin while drawing the footer.
    doc.page.margins.bottom = 0
    const y = doc.page.height - 44
    doc.moveTo(M.left, y - 8).lineTo(M.left + width, y - 8).lineWidth(0.5).strokeColor(C.line).stroke()
    doc.fillColor(C.muted).font(F.regular).fontSize(8)
    doc.text('Made with Jara AI (usejara.xyz), paid with G$. Check facts against current sources and write in your own words.', M.left, y, { width: width - 50, lineBreak: false })
    doc.text(`${i + 1} / ${range.count}`, M.left, y, { width, align: 'right', lineBreak: false })
  }

  doc.end()
  return done
}
