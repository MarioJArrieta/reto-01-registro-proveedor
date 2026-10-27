// Empaqueta el agente en modulo/ a partir de las MISMAS fuentes que usa la app (sin copias divergentes):
//   agent/prompt.md                      → modulo/agent.md
//   src/knowledge/registro-proveedor.md  → modulo/skill/registro-proveedor/SKILL.md
//   src/tools/proveedor.ts               ← modulo/tools/proveedor.ts lo re-exporta (no es copia)
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pares = [
  ["agent/prompt.md", "modulo/agent.md"],
  ["src/knowledge/registro-proveedor.md", "modulo/skill/registro-proveedor/SKILL.md"],
] as const

export async function verificarModulo(dir: string): Promise<boolean> {
  for (const [origen, destino] of pares) {
    try {
      const [a, b] = await Promise.all([readFile(path.join(dir, origen), "utf8"), readFile(path.join(dir, destino), "utf8")])
      if (a !== b) return false
    } catch {
      return false
    }
  }
  return true
}

async function construir(dir: string) {
  for (const [origen, destino] of pares) {
    await mkdir(path.dirname(path.join(dir, destino)), { recursive: true })
    await writeFile(path.join(dir, destino), await readFile(path.join(dir, origen), "utf8"))
    console.log(`${origen} → ${destino}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await construir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
}
