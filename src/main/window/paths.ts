import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function getPreloadPath(): string {
  const cjs = path.join(__dirname, '../../preload/preload.cjs')
  if (fs.existsSync(cjs)) return cjs
  return path.join(__dirname, '../../preload/preload.js')
}

export function getRendererHtmlPath(): string {
  const built = path.join(__dirname, '../../renderer/index.html')
  if (fs.existsSync(built)) return built
  const srcPath = path.join(__dirname, '../../../src/renderer/index.html')
  if (fs.existsSync(srcPath)) return srcPath
  return path.join(process.cwd(), 'src/renderer/index.html')
}
