// API HTTP del chat. Sin framework: node:http basta para tres rutas y un archivo estático.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { ejecutarTurno, nuevaSesion, type Config, type Sesion } from "./agente.ts"
import type { ProveedorLLM } from "./llm/adapter.ts"
import { ProveedorAnthropic } from "./llm/anthropic.ts"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Carga .env local si existe (en producción las variables vienen del entorno / secretos).
try {
  for (const linea of readFileSync(path.join(raiz, ".env"), "utf8").split("\n")) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
} catch {
  // sin .env
}
const entero = (v: string | undefined, def: number) => (v && /^\d+$/.test(v) ? Number(v) : def)

const cfg: Config = {
  directorio: raiz,
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 400_000),
}
const puerto = entero(process.env.PORT, 3000)
const claveAcceso = process.env.ACCESS_KEY ?? ""
const maxSesiones = entero(process.env.MAX_SESIONES, 200)

function crearProveedor(): ProveedorLLM | null {
  const clave = process.env.ANTHROPIC_API_KEY
  if (!clave) return null
  return new ProveedorAnthropic(clave, process.env.LLM_MODEL ?? "claude-sonnet-5-5", entero(process.env.LLM_TIMEOUT_MS, 90_000))
}
const llm = crearProveedor()
const sesiones = new Map<string, Sesion>()
const ocupadas = new Set<string>()

// ---------- utilidades HTTP ----------

function responder(res: ServerResponse, status: number, cuerpo: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage, max = 20_000): Promise<unknown> {
  let total = 0
  const partes: Buffer[] = []
  for await (const parte of req) {
    total += (parte as Buffer).length
    if (total > max) throw new Error("demasiado grande")
    partes.push(parte as Buffer)
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

function autorizado(req: IncomingMessage): boolean {
  if (!claveAcceso) return true
  const dada = Buffer.from(String(req.headers["x-access-key"] ?? ""))
  const esperada = Buffer.from(claveAcceso)
  return dada.length === esperada.length && timingSafeEqual(dada, esperada)
}

const ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const Chat = z.object({ sessionId: ID, message: z.string().trim().min(1).max(4000) })

// ---------- rutas ----------

async function chat(req: IncomingMessage, res: ServerResponse) {
  if (!llm) return responder(res, 503, { error: "El servidor no tiene configurado ANTHROPIC_API_KEY." })
  let cuerpo: z.infer<typeof Chat>
  try {
    cuerpo = Chat.parse(await leerCuerpo(req))
  } catch {
    return responder(res, 400, { error: "Cuerpo inválido: se espera { sessionId, message }." })
  }
  let s = sesiones.get(cuerpo.sessionId)
  if (!s) {
    if (sesiones.size >= maxSesiones) return responder(res, 429, { error: "Se alcanzó el máximo de sesiones del servidor." })
    s = nuevaSesion(cuerpo.sessionId)
    sesiones.set(s.id, s)
  }
  if (ocupadas.has(s.id)) return responder(res, 409, { error: "El agente aún está respondiendo el mensaje anterior." })
  ocupadas.add(s.id)
  try {
    responder(res, 200, await ejecutarTurno(s, cuerpo.message, llm, cfg))
  } finally {
    ocupadas.delete(s.id)
  }
}

async function estatico(res: ServerResponse) {
  const html = await readFile(path.join(raiz, "web", "index.html"))
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(html)
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  try {
    if (req.method === "GET" && url.pathname === "/") return await estatico(res)
    if (req.method === "GET" && url.pathname === "/api/health") {
      return responder(res, 200, { ok: true, provider: llm?.proveedor ?? null, model: llm?.modelo ?? null, accessKeyRequired: Boolean(claveAcceso) })
    }
    if (!url.pathname.startsWith("/api/")) return responder(res, 404, { error: "No encontrado." })
    if (!autorizado(req)) return responder(res, 401, { error: "Clave de acceso inválida." })
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res)
    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === "GET" && m) {
      const s = sesiones.get(m[1])
      return s ? responder(res, 200, { id: s.id, tokens: s.tokens, historial: s.visible }) : responder(res, 404, { error: "Sesión no encontrada." })
    }
    return responder(res, 404, { error: "No encontrado." })
  } catch {
    if (!res.headersSent) responder(res, 500, { error: "Error interno del servidor." })
  }
})

servidor.listen(puerto, () => {
  console.log(`Agente escuchando en http://localhost:${puerto} · modelo: ${llm ? `${llm.proveedor}/${llm.modelo}` : "SIN CLAVE"}`)
})
