// Ejecuta todos los casos llamando directamente a las herramientas, sin modelo ni clave.
// Uso: npm run demo   (o: bun run demo.ts)
import { rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { armar_paquete, generar_formulario, leer_solicitud, listar_casos, mapear_campos, simular_envio } from "./src/tools/proveedor.ts"
import { verificarModulo } from "./scripts/build-modulo.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }

type R = { ok: boolean; error?: string; data?: Record<string, unknown> }
const parse = (s: string) => JSON.parse(s) as R

async function procesar(caso: string) {
  console.log(`\n━━━ ${caso} ━━━`)
  const sol = parse(await leer_solicitud.execute({ caso }, ctx))
  if (!sol.ok) return console.log(`  ✖ ${sol.error}`)
  const d = sol.data as { cliente: string; pais: string; formato: string; campos: unknown[]; soportes: string[] }
  console.log(`  Cliente: ${d.cliente} (${d.pais}) · formato ${d.formato} · ${d.campos.length} campos`)

  const map = parse(await mapear_campos.execute({ caso }, ctx))
  if (map.ok) {
    const m = map.data as { llenos: unknown[]; faltantes: { etiqueta: string }[]; requiere_confirmacion: { etiqueta: string }[] }
    console.log(`  Mapeo: ${m.llenos.length} llenos · faltantes [${m.faltantes.map((f) => f.etiqueta).join(", ")}]`)
    console.log(`         requiere_confirmacion [${m.requiere_confirmacion.map((f) => f.etiqueta).join(", ")}]`)
  }

  const gen = parse(await generar_formulario.execute({ caso }, ctx))
  console.log(gen.ok ? `  Formulario: ${(gen.data as { ruta: string }).ruta}` : `  ⚠ ${gen.error}`)

  const paq = parse(await armar_paquete.execute({ caso }, ctx))
  if (!paq.ok) return console.log(`  ✖ ${paq.error}`)
  const p = paq.data as { ruta: string; listo_para_firma: boolean; checklist: { soportes: { tipo: string; estado: string }[] } }
  console.log(`  Paquete: ${p.ruta} · listo_para_firma=${p.listo_para_firma}`)
  console.log(`  Soportes: ${p.checklist.soportes.map((s) => `${s.tipo}=${s.estado}`).join(", ")}`)

  const sinConfirmar = parse(await simular_envio.execute({ caso, confirmado: true }, ctx))
  console.log(`  Envío sin confirmación del usuario → ${sinConfirmar.ok ? "ENVIADO (¡error!)" : sinConfirmar.error}`)
}

async function erroresControlados() {
  console.log("\n━━━ Manejo de errores (HU-5) ━━━")
  console.log("  Caso inexistente →", parse(await leer_solicitud.execute({ caso: "no-existe" }, ctx)).error)
  console.log("  Argumento inválido →", parse(await leer_solicitud.execute({ caso: "../etc" }, ctx)).error)
}

await rm(path.join(directory, "out"), { recursive: true, force: true })
const lista = parse(await listar_casos.execute({}, ctx))
for (const caso of (lista.data?.casos as string[]) ?? []) await procesar(caso)
await erroresControlados()
console.log(`\nMódulo reutilizable sincronizado con la app: ${(await verificarModulo(directory)) ? "sí" : "NO (ejecuta npm run modulo)"}`)
