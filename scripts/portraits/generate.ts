// Generates one static patient portrait per case: public/portraits/<caseId>.webp.
// Offline only (never called by the app). Reads OPENAI_API_KEY from the environment or .env.
// Usage: tsx scripts/portraits/generate.ts [caseId ...]   (default: every case missing a portrait)
import 'dotenv/config'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import OpenAI from 'openai'
import sharp from 'sharp'

const SCENARIOS = 'content/scenarios'
const OUT = 'public/portraits'
const MODEL = 'gpt-image-1'
const QUALITY = 'medium'
const SIZE = 512
// gpt-image-1 list prices, USD per token.
const PRICE = { textIn: 5 / 1e6, imageIn: 10 / 1e6, imageOut: 40 / 1e6 }
const STYLE =
  'Square head-and-shoulders editorial portrait photograph, centered, looking at the camera, calm neutral expression, ' +
  'soft neutral light-grey seamless background, natural soft window lighting, realistic skin texture, no text, no logos, ' +
  'no jewelry, no medical equipment. A fictional person, not a real individual.'

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set (environment or .env).')
  process.exit(1)
}

const briefs: Record<string, string> = JSON.parse(readFileSync('scripts/portraits/briefs.json', 'utf8'))
const requested = process.argv.slice(2)
const cases = readdirSync(SCENARIOS)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.fixtures.json'))
  .map((f) => JSON.parse(readFileSync(join(SCENARIOS, f), 'utf8')) as { id: string; summary: { age: string; pronouns: string } })
  .filter((s) => (requested.length ? requested.includes(s.id) : !existsSync(join(OUT, `${s.id}.webp`))))

const client = new OpenAI()
mkdirSync(OUT, { recursive: true })
let total = 0

for (const s of cases) {
  const brief = briefs[s.id]
  const age = Number.parseInt(s.summary.age, 10)
  if (!brief || !Number.isFinite(age)) {
    console.warn(`skip ${s.id}: ${brief ? 'no numeric authored age' : 'no appearance brief'}`)
    continue
  }
  const prompt = `${age}-year-old ${brief}. ${STYLE}`
  const res = await client.images.generate({ model: MODEL, prompt, size: '1024x1024', quality: QUALITY, n: 1 })
  const b64 = res.data?.[0]?.b64_json
  if (!b64) throw new Error(`${s.id}: no image returned`)
  const out = join(OUT, `${s.id}.webp`)
  writeFileSync(out, await sharp(Buffer.from(b64, 'base64')).resize(SIZE, SIZE).webp({ quality: 80 }).toBuffer())
  const u = res.usage
  const cost = u
    ? (u.input_tokens_details?.text_tokens ?? u.input_tokens) * PRICE.textIn +
      (u.input_tokens_details?.image_tokens ?? 0) * PRICE.imageIn +
      u.output_tokens * PRICE.imageOut
    : Number.NaN
  total += cost
  console.log(`${s.id}: ${out} ($${cost.toFixed(4)})`)
}
console.log(`total: $${total.toFixed(4)}`)
