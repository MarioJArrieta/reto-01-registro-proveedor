// Utilidades compartidas por las herramientas: rutas, resultados tipados, log y validación.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import reglasJson from "../../knowledge/reglas.json" with { type: "json" }

export type Ctx = {
  directory: string
  sessionId: string
  /** Lo calcula el servidor: el usuario confirmó en el mensaje inmediatamente posterior a la pregunta del agente. */
  confirmacionUsuario?: boolean
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string; data?: T }

export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<string>
}

export const reglas = reglasJson

export const CASO = z
  .string()
  .regex(/^[a-z0-9-]+$/, "solo minúsculas, números y guiones")
  .describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/ (ej. ec-corp-andina)")

export const rutas = (dir: string) => {
  const fixtures = path.join(dir, "fixtures", "reto-01")
  const out = path.join(dir, "out")
  return {
    casos: path.join(fixtures, "casos"),
    caso: (c: string) => path.join(fixtures, "casos", c),
    maestro: path.join(fixtures, "repositorio", "maestro.json"),
    soportes: path.join(fixtures, "repositorio", "soportes"),
    glosario: path.join(fixtures, "glosario-campos.json"),
    out,
    outCaso: (c: string) => path.join(out, c),
  }
}

/** Ruta relativa a la raíz del proyecto, para mostrar al usuario sin exponer rutas absolutas. */
export const relativa = (dir: string, p: string) => path.relative(dir, p)

export class ErrorClaro extends Error {}

export async function leerJson(archivo: string, nombre: string): Promise<unknown> {
  let texto: string
  try {
    texto = await readFile(archivo, "utf8")
  } catch {
    throw new ErrorClaro(`No existe ${nombre}.`)
  }
  try {
    return JSON.parse(texto)
  } catch {
    throw new ErrorClaro(`${nombre} está corrupto (no es JSON válido).`)
  }
}

/** Fecha de ejecución (YYYY-MM-DD). Configurable con FECHA_EJECUCION para reproducir resultados. */
export function fechaEjecucion(): string {
  const env = process.env.FECHA_EJECUCION
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) return env
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

async function registrar(ctx: Ctx, caso: string | undefined, entrada: object) {
  const r = rutas(ctx.directory)
  const linea = JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, ...entrada }) + "\n"
  await mkdir(r.out, { recursive: true })
  await appendFile(path.join(r.out, "log.jsonl"), linea)
  if (caso && /^[a-z0-9-]+$/.test(caso)) {
    await mkdir(r.outCaso(caso), { recursive: true })
    await appendFile(path.join(r.outCaso(caso), "log.jsonl"), linea)
  }
}

/**
 * Construye una herramienta que cumple el contrato: valida con zod, nunca lanza,
 * devuelve JSON `{ ok, data }` / `{ ok: false, error }` y deja registro (RN5).
 */
export function herramienta<S extends z.ZodRawShape, T>(
  nombre: string,
  def: {
    description: string
    args: S
    run: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<Resultado<T>>
    resumen: (r: Resultado<T>) => string
  },
): Herramienta<S> {
  const esquema = z.object(def.args)
  return {
    description: def.description,
    args: def.args,
    async execute(args, ctx) {
      const caso = typeof (args as { caso?: unknown }).caso === "string" ? (args as { caso: string }).caso : undefined
      let res: Resultado<T>
      const val = esquema.safeParse(args)
      if (!val.success) {
        res = { ok: false, error: `Argumentos inválidos: ${z.prettifyError(val.error)}` }
      } else {
        try {
          res = await def.run(val.data, ctx)
        } catch (e) {
          res = { ok: false, error: e instanceof ErrorClaro ? e.message : "Error interno de la herramienta." }
        }
      }
      try {
        await registrar(ctx, caso, { herramienta: nombre, ok: res.ok, resumen: def.resumen(res) })
      } catch {
        // El log nunca debe tumbar la herramienta.
      }
      return JSON.stringify(res)
    },
  }
}

export const ok = <T>(data: T): Resultado<T> => ({ ok: true, data })
export const falla = <T>(error: string, data?: T): Resultado<T> => ({ ok: false, error, data })
