import axe from 'axe-core'

/**
 * Runs axe-core against a rendered container in jsdom. Color contrast is disabled here because jsdom
 * cannot compute styles; contrast is covered by scripts/theme/contrast.test.ts and the Playwright suite.
 */
export async function axeViolations(container: Element) {
  const result = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
}
