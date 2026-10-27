// Ciclo del agente: prompt → modelo → herramientas → respuesta, con topes y confirmación humana.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import * as proveedor from "./tools/proveedor.ts"
import type { Ctx } from "./tools/_lib/comun.ts"
import { ErrorLLM, type Bloque, type DefinicionHerramienta, type Mensaje, type ProveedorLLM } from "./llm/adapter.ts"

// ---------- Registro de herramientas: cada export de src/tools/<archivo>.ts → <archivo>_<export> ----------

/** Vista mínima de una herramienta: los argumentos los valida la propia herramienta con zod. */
type HerramientaGenerica = { description: string; args: z.ZodRawShape; execute: (args: never, ctx: Ctx) => Promise<string> }
const modulos: Record<string, Record<string, HerramientaGenerica>> = { proveedor }

export const herramientas: Record<string, HerramientaGenerica> = Object.fromEntries(
  Object.entries(modulos).flatMap(([archivo, exports]) => Object.entries(exports).map(([nombre, h]) => [`${archivo}_${nombre}`, h])),
)

export const definiciones: DefinicionHerramienta[] = Object.entries(herramientas).map(([nombre, h]) => {
  const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
  return { nombre, descripcion: h.description, esquema }
})

// ---------- Sistema: comportamiento (agent/prompt.md) + conocimiento (src/knowledge) ----------

const sinFrontmatter = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, "")

export async function promptSistema(dir: string): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(dir, "agent", "prompt.md"), "utf8"),
    readFile(path.join(dir, "src", "knowledge", "registro-proveedor.md"), "utf8"),
  ])
  return `${sinFrontmatter(prompt)}\n\n# Conocimiento del proceso\n${sinFrontmatter(conocimiento)}`
}

// ---------- Sesión ----------

export type LlamadaVisible = { nombre: string; args: Record<string, unknown>; ok: boolean; resumen: string }
export type EntradaVisible =
  | { rol: "usuario"; texto: string; ts: string }
  | { rol: "agente"; texto: string; ts: string; llamadas: LlamadaVisible[]; pideConfirmacion: boolean; error?: boolean }

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  visible: EntradaVisible[]
  tokens: number
  esperandoConfirmacion: boolean
}

export const nuevaSesion = (id: string): Sesion => ({ id, mensajes: [], visible: [], tokens: 0, esperandoConfirmacion: false })

export type Config = { maxIteraciones: number; maxTokensSesion: number; directorio: string }

export type Turno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: boolean }

const MARCA = "[CONFIRMACION]"
const AFIRMATIVA = /^\s*(s[ií]|confirmo|confirmado|dale|ok|okay|de acuerdo|adelante|procede|hazlo|env[ií]a(lo)?|apruebo|aprobado)(?=[\s,.!;:]|$)/iu

/** RN4: solo cuenta como confirmación un "sí" explícito justo después de que el agente la pidió. */
export const esConfirmacion = (s: Sesion, texto: string) => s.esperandoConfirmacion && AFIRMATIVA.test(texto)

function resumenResultado(json: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(json) as { ok: boolean; error?: string; data?: unknown }
    const resumen = r.ok ? JSON.stringify(r.data) : `${r.error}`
    return { ok: r.ok, resumen: resumen.length > 600 ? `${resumen.slice(0, 600)}…` : resumen }
  } catch {
    return { ok: false, resumen: "Resultado ilegible." }
  }
}

async function ejecutarLlamadas(llamadas: Extract<Bloque, { tipo: "llamada" }>[], ctx: Ctx, visibles: LlamadaVisible[]): Promise<Bloque[]> {
  const resultados: Bloque[] = []
  for (const ll of llamadas) {
    const h = herramientas[ll.nombre]
    const json = h
      ? await h.execute(ll.args as never, ctx)
      : JSON.stringify({ ok: false, error: `La herramienta ${ll.nombre} no existe.` })
    const { ok, resumen } = resumenResultado(json)
    visibles.push({ nombre: ll.nombre, args: ll.args, ok, resumen })
    resultados.push({ tipo: "resultado", id: ll.id, contenido: json, error: !ok })
  }
  return resultados
}

const textoDe = (bloques: Bloque[]) =>
  bloques.filter((b): b is Extract<Bloque, { tipo: "texto" }> => b.tipo === "texto").map((b) => b.texto).join("\n").trim()

export async function ejecutarTurno(s: Sesion, texto: string, llm: ProveedorLLM, cfg: Config): Promise<Turno> {
  const ctx: Ctx = { directory: cfg.directorio, sessionId: s.id, confirmacionUsuario: esConfirmacion(s, texto) }
  const ahora = () => new Date().toISOString()
  s.visible.push({ rol: "usuario", texto, ts: ahora() })
  const respaldo = s.mensajes.length
  s.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto }] })
  const llamadas: LlamadaVisible[] = []
  let reply = ""
  try {
    const sistema = await promptSistema(cfg.directorio)
    for (let i = 0; ; i++) {
      if (s.tokens >= cfg.maxTokensSesion) {
        reply = `Se alcanzó el tope de uso de esta sesión (${cfg.maxTokensSesion} tokens). Abre una sesión nueva para continuar.`
        break
      }
      if (i >= cfg.maxIteraciones) {
        reply = `Alcancé el tope de ${cfg.maxIteraciones} pasos en este turno. Esto es lo que alcancé a hacer: ${llamadas.map((l) => l.nombre).join(", ") || "nada"}. Pídeme continuar para terminar lo que falta.`
        break
      }
      const r = await llm.enviar(s.mensajes, definiciones, sistema)
      s.tokens += r.uso.entrada + r.uso.salida
      s.mensajes.push({ rol: "asistente", bloques: r.bloques })
      const pedidas = r.bloques.filter((b): b is Extract<Bloque, { tipo: "llamada" }> => b.tipo === "llamada")
      if (!pedidas.length) {
        reply = textoDe(r.bloques)
        break
      }
      s.mensajes.push({ rol: "usuario", bloques: await ejecutarLlamadas(pedidas, ctx, llamadas) })
    }
  } catch (e) {
    s.mensajes.length = respaldo // la sesión sigue viva y coherente (CA5)
    const msg = e instanceof ErrorLLM ? e.message : "Ocurrió un error inesperado procesando tu mensaje. Intenta de nuevo."
    s.visible.push({ rol: "agente", texto: msg, ts: ahora(), llamadas, pideConfirmacion: false, error: true })
    return { reply: msg, toolCalls: llamadas, needsConfirmation: false, error: true }
  }
  const needsConfirmation = reply.includes(MARCA)
  reply = reply.replaceAll(MARCA, "").trim()
  s.esperandoConfirmacion = needsConfirmation
  s.visible.push({ rol: "agente", texto: reply, ts: ahora(), llamadas, pideConfirmacion: needsConfirmation })
  return { reply, toolCalls: llamadas, needsConfirmation }
}
