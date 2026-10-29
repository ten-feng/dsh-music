// 生成预览用的测试音频（44.1k 16bit 单声道 WAV，40s，带 100BPM 节拍包络）
// 和 6 张渐变 SVG 假封面 + demo 歌词。node dev/gen-fixture.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
mkdirSync(dir, { recursive: true })

/* ---- tone.wav ---- */
const SR = 44100
const DUR = 40
const samples = new Int16Array(SR * DUR)
for (let i = 0; i < samples.length; i++) {
  const t = i / SR
  const beatPhase = (t * (100 / 60)) % 1
  const drum = Math.exp(-beatPhase * 9) * Math.sin(2 * Math.PI * (55 + 30 * Math.exp(-beatPhase * 20)) * t)
  const chord = 0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.22 * Math.sin(2 * Math.PI * 277.18 * t) + 0.18 * Math.sin(2 * Math.PI * 329.63 * t)
  const hat = (t * (100 / 60) * 2) % 1 < 0.04 ? 0.12 * (Math.random() * 2 - 1) : 0
  const v = (drum * 0.9 + chord * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.05 * t)) + hat) * 0.5
  samples[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)))
}
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + samples.length * 2, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(SR, 24)
header.writeUInt32LE(SR * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(samples.length * 2, 40)
writeFileSync(join(dir, 'tone.wav'), Buffer.concat([header, Buffer.from(samples.buffer)]))

/* ---- 封面 ---- */
const covers = [
  ['#667eea', '#764ba2', '☁'],
  ['#f093fb', '#f5576c', '♥'],
  ['#4facfe', '#00f2fe', '★'],
  ['#43e97b', '#38f9d7', '♪'],
  ['#fa709a', '#fee140', '☀'],
  ['#30cfd0', '#330867', '☾'],
]
covers.forEach(([a, b, glyph], i) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="500" height="500" fill="url(#g)"/><circle cx="250" cy="250" r="150" fill="rgba(255,255,255,.14)"/><text x="250" y="300" font-size="150" text-anchor="middle">${glyph}</text></svg>`
  writeFileSync(join(dir, `cover${i + 1}.svg`), svg)
})

/* ---- demo 歌词（每 3.4s 一行，覆盖 40s） ---- */
const lines = [
  '窗外的雨落在旧琴键上', '回忆像气泡慢慢升起', '玻璃里的灯光忽明忽暗',
  '悬浮的音符停在半空', '你哼的那首歌还在盘旋', '时间在这一刻变得很轻',
  '我们都是夜里的听众', '把心事交给一段旋律', '气泡破了就成了星光',
  '玻璃外的城市睡着了', '只有节奏还醒着跳动', '这首歌送还给深夜的你',
]
const lrc = lines.map((text, i) => {
  const t = i * 3.4
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `[${m}:${s}]${text}`
}).join('\n')
writeFileSync(join(dir, 'demo.lrc'), lrc)

console.log('fixtures ready →', dir)
