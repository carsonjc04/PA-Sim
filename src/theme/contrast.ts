/** WCAG 2.x relative luminance and contrast ratio for #rgb / #rrggbb colors. */
export function luminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Custom properties declared in the first rule whose selector matches exactly (minified CSS). */
export function tokensOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector}{`)
  if (start === -1) throw new Error(`No rule for ${selector}`)
  const body = css.slice(start + selector.length + 1, css.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const decl of body.split(';')) {
    const m = decl.match(/^\s*(--[\w-]+)\s*:\s*(.+)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}
