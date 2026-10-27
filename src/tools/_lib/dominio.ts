// Lógica de negocio pura: lectura del caso, mapeo contra el maestro y estado de soportes.
import { access, readdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ErrorClaro, leerJson, reglas, rutas } from "./comun.ts"

// ---------- Esquemas de los fixtures ----------

const Solicitud = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.string(),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof Solicitud>

const Celda = z.object({ hoja: z.string(), celda_etiqueta: z.string(), etiqueta: z.string(), celda_valor: z.string() })
const CampoPdf = z.object({ etiqueta: z.string(), obligatorio: z.boolean() })
export type Celda = z.infer<typeof Celda>

const Soporte = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string(),
})
type Soporte = z.infer<typeof Soporte>

export type Formato = "xlsx" | "pdf" | "portal"

export type CampoSolicitado = {
  etiqueta: string
  obligatorio: boolean
  /** Solo en xlsx: dónde escribir. */
  celda?: Celda
}

export type Caso = {
  solicitud: Solicitud
  formato: Formato | "desconocido"
  campos: CampoSolicitado[]
  soportes: string[]
  advertencias: string[]
}

// ---------- Lectura del caso ----------

async function existe(p: string) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function listarCasos(dir: string): Promise<string[]> {
  try {
    const items = await readdir(rutas(dir).casos, { withFileTypes: true })
    return items.filter((i) => i.isDirectory()).map((i) => i.name).sort()
  } catch {
    return []
  }
}

async function leerPlantilla(carpeta: string, advertencias: string[]): Promise<CampoSolicitado[]> {
  const celdas = path.join(carpeta, "plantilla-celdas.json")
  const campos = path.join(carpeta, "plantilla-campos.json")
  try {
    if (await existe(celdas)) {
      const lista = z.array(Celda).parse(await leerJson(celdas, "plantilla-celdas.json"))
      return lista.map((c) => ({ etiqueta: c.etiqueta, obligatorio: true, celda: c }))
    }
    if (await existe(campos)) {
      const lista = z.array(CampoPdf).parse(await leerJson(campos, "plantilla-campos.json"))
      return lista.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
    }
    advertencias.push("El caso no trae plantilla de campos.")
  } catch (e) {
    advertencias.push(e instanceof ErrorClaro ? e.message : "La plantilla está corrupta o no tiene la estructura esperada.")
  }
  return []
}

export async function leerCaso(dir: string, caso: string): Promise<Caso> {
  const carpeta = rutas(dir).caso(caso)
  if (!(await existe(carpeta))) {
    const disponibles = await listarCasos(dir)
    throw new ErrorClaro(`El caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ")}.`)
  }
  const sol = Solicitud.safeParse(await leerJson(path.join(carpeta, "solicitud.json"), "solicitud.json"))
  if (!sol.success) throw new ErrorClaro("solicitud.json no tiene la estructura esperada.")
  const advertencias: string[] = []
  const campos = await leerPlantilla(carpeta, advertencias)
  let soportes: string[] = []
  try {
    soportes = z.array(z.string()).parse(await leerJson(path.join(carpeta, "soportes-exigidos.json"), "soportes-exigidos.json"))
  } catch (e) {
    advertencias.push(e instanceof ErrorClaro ? e.message : "soportes-exigidos.json no tiene la estructura esperada.")
  }
  const f = sol.data.formato
  const formato = f === "xlsx" || f === "pdf" || f === "portal" ? f : "desconocido"
  if (formato === "desconocido") advertencias.push(`Formato de salida no soportado: "${f}".`)
  return { solicitud: sol.data, formato, campos, soportes, advertencias }
}

// ---------- Maestro y glosario ----------

export type Maestro = Record<string, unknown>

export async function leerMaestro(dir: string): Promise<Maestro> {
  const m = await leerJson(rutas(dir).maestro, "el repositorio maestro (maestro.json)")
  if (typeof m !== "object" || m === null) throw new ErrorClaro("maestro.json no es un objeto.")
  return m as Maestro
}

export async function leerGlosario(dir: string): Promise<Record<string, string>> {
  return z.record(z.string(), z.string()).parse(await leerJson(rutas(dir).glosario, "glosario-campos.json"))
}

/** Resuelve "a.b.c" dentro del maestro. Devuelve undefined si no existe o es null. */
export function valorEnMaestro(maestro: Maestro, ruta: string): string | undefined {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null) return undefined
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (actual === undefined || actual === null || typeof actual === "object") return undefined
  return String(actual)
}

// ---------- Mapeo ----------

export const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

const VACIAS = new Set(["de", "del", "la", "el", "los", "las", "o", "y", "en", "a"])
const tokens = (s: string) =>
  new Set(normalizar(s).split(" ").filter((t) => t && !VACIAS.has(t)).map((t) => t.replace(/(es|s)$/, "")))

/** Similitud de Dice entre conjuntos de palabras (0..1). */
function similitud(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return (2 * comunes) / (ta.size + tb.size)
}

export type Lleno = { etiqueta: string; ruta: string; valor: string; confianza: number; sensible: boolean }
export type Faltante = { etiqueta: string; motivo: string }
export type PorConfirmar = {
  etiqueta: string
  ruta_propuesta: string
  /** Presente solo cuando una regla de negocio ordena llenarlo (RN1). */
  valor?: string
  confianza: number
  motivo: string
}
export type Mapeo = { llenos: Lleno[]; faltantes: Faltante[]; requiere_confirmacion: PorConfirmar[] }

const nombrePais: Record<string, string> = { CO: "Colombia", EC: "Ecuador", PE: "Perú", PA: "Panamá", HN: "Honduras" }

function identificadorDelPais(pais: string): string | undefined {
  return (reglas.identificador_tributario_por_pais as Record<string, string>)[pais]
}

function mejorCandidato(etiqueta: string, glosario: Record<string, string>) {
  let mejor = { ruta: "", confianza: 0, origen: "" }
  for (const [sinonimo, ruta] of Object.entries(glosario)) {
    const s = similitud(etiqueta, sinonimo)
    if (s > mejor.confianza) mejor = { ruta, confianza: s, origen: sinonimo }
  }
  return mejor
}

type Clasificado =
  | { estado: "lleno"; item: Lleno }
  | { estado: "faltante"; item: Faltante }
  | { estado: "requiere_confirmacion"; item: PorConfirmar }

function clasificarIdentificador(etiqueta: string, valor: string, pais: string, ambigua: boolean): Clasificado {
  const id = identificadorDelPais(pais)
  const ruta = reglas.campo_identificador_tributario
  if (pais !== reglas.pais_origen_maestro) {
    return {
      estado: "requiere_confirmacion",
      item: {
        etiqueta, ruta_propuesta: ruta, valor, confianza: 1,
        motivo: `identificador extranjero: en ${nombrePais[pais] ?? pais} se pide ${id ?? "un identificador local"}; Periferia solo tiene NIT colombiano. Se llena con el NIT y debe confirmarse con el cliente (RN1).`,
      },
    }
  }
  if (ambigua) {
    return {
      estado: "requiere_confirmacion",
      item: { etiqueta, ruta_propuesta: ruta, valor, confianza: 0.9, motivo: `Etiqueta ambigua; en ${nombrePais[pais] ?? pais} el equivalente es ${id}.` },
    }
  }
  return { estado: "lleno", item: { etiqueta, ruta, valor, confianza: 1, sensible: false } }
}

function clasificar(etiqueta: string, pais: string, maestro: Maestro, glosario: Record<string, string>): Clasificado {
  const norm = normalizar(etiqueta)
  const exacto = Object.entries(glosario).find(([k]) => normalizar(k) === norm)
  const cand = exacto ? { ruta: exacto[1], confianza: 1, origen: exacto[0] } : mejorCandidato(etiqueta, glosario)

  if (cand.confianza < reglas.umbral_candidato) {
    return { estado: "faltante", item: { etiqueta, motivo: "No hay un dato equivalente en el repositorio maestro." } }
  }
  const valor = valorEnMaestro(maestro, cand.ruta)
  if (valor === undefined) {
    return { estado: "faltante", item: { etiqueta, motivo: `El maestro no tiene valor en "${cand.ruta}".` } }
  }
  if (cand.confianza < reglas.umbral_confianza) {
    return {
      estado: "requiere_confirmacion",
      item: { etiqueta, ruta_propuesta: cand.ruta, confianza: round(cand.confianza), motivo: `Coincidencia parcial con "${cand.origen}"; confirmar antes de llenar.` },
    }
  }
  if (cand.ruta === reglas.campo_identificador_tributario) {
    const ambigua = reglas.etiquetas_ambiguas.some((a) => normalizar(a) === norm)
    return clasificarIdentificador(etiqueta, valor, pais, ambigua)
  }
  const sensible = reglas.campos_bancarios.includes(cand.ruta)
  return { estado: "lleno", item: { etiqueta, ruta: cand.ruta, valor, confianza: round(cand.confianza), sensible } }
}

const round = (n: number) => Math.round(n * 100) / 100

export function mapear(etiquetas: string[], pais: string, maestro: Maestro, glosario: Record<string, string>): Mapeo {
  const m: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const etiqueta of etiquetas) {
    const c = clasificar(etiqueta, pais, maestro, glosario)
    if (c.estado === "lleno") m.llenos.push(c.item)
    else if (c.estado === "faltante") m.faltantes.push(c.item)
    else m.requiere_confirmacion.push(c.item)
  }
  return m
}

/** Etiquetas ambiguas que HU-1 pide reportar al leer la solicitud. */
export function ambiguas(etiquetas: string[], pais: string) {
  return etiquetas
    .filter((e) => reglas.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(e)))
    .map((e) => ({ etiqueta: e, estado: "requiere_confirmacion" as const, propuesta: identificadorDelPais(pais) ?? "NIT" }))
}

// ---------- Soportes ----------

export type EstadoSoporte = {
  tipo: string
  nombre: string
  estado: "presente" | "ausente" | "vencido"
  archivo?: string
  vigencia_hasta?: string | null
}

export async function revisarSoportes(dir: string, exigidos: string[], fecha: string): Promise<EstadoSoporte[]> {
  const indice = z.array(Soporte).parse(await leerJson(path.join(rutas(dir).soportes, "index.json"), "el índice de soportes"))
  const nombres = reglas.nombres_soporte as Record<string, string>
  return exigidos.map((tipo) => {
    const s: Soporte | undefined = indice.find((x) => x.tipo === tipo)
    const nombre = nombres[tipo] ?? tipo
    if (!s) return { tipo, nombre, estado: "ausente" }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < fecha
    return { tipo, nombre, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta }
  })
}
