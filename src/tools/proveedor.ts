// Herramientas del agente. Cada export se expone al modelo como proveedor_<export>.
// Son la única fuente de valores que el agente puede afirmar (CA2).
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { CASO, ErrorClaro, falla, fechaEjecucion, herramienta, ok, relativa, rutas, type Ctx } from "./_lib/comun.ts"
import {
  ambiguas, leerCaso, leerGlosario, leerMaestro, listarCasos, mapear, revisarSoportes, valorEnMaestro,
  type Caso, type EstadoSoporte, type Mapeo,
} from "./_lib/dominio.ts"
import { escribirPdf, escribirValoresPortal, escribirXlsx, type Fila } from "./_lib/formatos.ts"

// ---------- proveedor_listar_casos ----------

export const listar_casos = herramienta("proveedor_listar_casos", {
  description: "Lista los casos (solicitudes de registro) disponibles en la carpeta de entrada.",
  args: {},
  run: async (_a, ctx) => ok({ casos: await listarCasos(ctx.directory) }),
  resumen: (r) => (r.ok ? `${r.data.casos.length} casos` : r.error),
})

// ---------- proveedor_leer_solicitud (HU-1) ----------

export const leer_solicitud = herramienta("proveedor_leer_solicitud", {
  description: "Lee el correo y la plantilla de un caso: país, cliente, formato de salida, campos pedidos y soportes exigidos.",
  args: { caso: CASO },
  run: async ({ caso }, ctx) => {
    const c = await leerCaso(ctx.directory, caso)
    const etiquetas = c.campos.map((x) => x.etiqueta)
    return ok({
      pais: c.solicitud.pais,
      cliente: c.solicitud.cliente,
      remitente: c.solicitud.de,
      asunto: c.solicitud.asunto,
      fecha: c.solicitud.fecha,
      formato: c.formato,
      campos: c.campos.map((x) => ({ etiqueta: x.etiqueta, obligatorio: x.obligatorio })),
      soportes: c.soportes,
      ambiguos: ambiguas(etiquetas, c.solicitud.pais),
      advertencias: c.advertencias,
    })
  },
  resumen: (r) => (r.ok ? `${r.data.cliente} (${r.data.pais}) · ${r.data.formato} · ${r.data.campos.length} campos · ${r.data.soportes.length} soportes` : r.error),
})

// ---------- proveedor_mapear_campos (HU-2) ----------

async function calcularMapeo(dir: string, caso: Caso, etiquetas?: string[]): Promise<Mapeo> {
  const lista = etiquetas?.length ? etiquetas : caso.campos.map((c) => c.etiqueta)
  return mapear(lista, caso.solicitud.pais, await leerMaestro(dir), await leerGlosario(dir))
}

export const mapear_campos = herramienta("proveedor_mapear_campos", {
  description: "Cruza los campos pedidos con el repositorio maestro y los clasifica en llenos, faltantes o requiere_confirmacion.",
  args: {
    caso: CASO,
    campos: z.array(z.string()).optional().describe("Etiquetas a mapear; si se omite se usan todas las de la plantilla del caso"),
  },
  run: async ({ caso, campos }, ctx) => {
    const c = await leerCaso(ctx.directory, caso)
    const m = await calcularMapeo(ctx.directory, c, campos)
    await mkdir(rutas(ctx.directory).outCaso(caso), { recursive: true })
    await writeFile(path.join(rutas(ctx.directory).outCaso(caso), "mapeo.json"), JSON.stringify(m, null, 2))
    return ok(m)
  },
  resumen: (r) => (r.ok ? `${r.data.llenos.length} llenos · ${r.data.faltantes.length} faltantes · ${r.data.requiere_confirmacion.length} por confirmar` : r.error),
})

// ---------- proveedor_generar_formulario (HU-3) ----------

type Generado = { ruta: string; formato: string; llenos: number; faltantes: number; por_confirmar: number }

const nombreFormulario = { xlsx: "formulario.xlsx", pdf: "formulario.pdf", portal: "valores-portal.md" } as const

async function construirFilas(dir: string, c: Caso, confirmados: string[]): Promise<Fila[]> {
  const m = await calcularMapeo(dir, c)
  const maestro = await leerMaestro(dir)
  const aprobado = (e: string) => confirmados.some((x) => x.trim().toLowerCase() === e.toLowerCase())
  return c.campos.map((campo): Fila => {
    const lleno = m.llenos.find((x) => x.etiqueta === campo.etiqueta)
    if (lleno) return { campo, valor: lleno.valor, estado: "lleno" }
    const pc = m.requiere_confirmacion.find((x) => x.etiqueta === campo.etiqueta)
    if (pc) {
      // El valor siempre sale del maestro; la confirmación del usuario solo decide si se escribe.
      const valor = pc.valor ?? (aprobado(campo.etiqueta) ? valorEnMaestro(maestro, pc.ruta_propuesta) ?? "" : "")
      return aprobado(campo.etiqueta) ? { campo, valor, estado: "lleno" } : { campo, valor, estado: "requiere_confirmacion", nota: pc.motivo }
    }
    return { campo, valor: "", estado: "faltante" }
  })
}

async function generar(dir: string, caso: string, confirmados: string[]) {
  const c = await leerCaso(dir, caso)
  if (c.formato === "desconocido") throw new ErrorClaro(`Formato no soportado: "${c.solicitud.formato}".`)
  if (!c.campos.length) throw new ErrorClaro(`No se puede generar el formulario: ${c.advertencias.join(" ") || "la plantilla no tiene campos."}`)
  const filas = await construirFilas(dir, c, confirmados)
  const carpeta = rutas(dir).outCaso(caso)
  await mkdir(carpeta, { recursive: true })
  const archivo = path.join(carpeta, nombreFormulario[c.formato])
  if (c.formato === "xlsx") await escribirXlsx(archivo, filas)
  else if (c.formato === "pdf") await escribirPdf(archivo, filas, c.solicitud)
  else await escribirValoresPortal(archivo, filas, c.solicitud)
  const cuenta = (e: Fila["estado"]) => filas.filter((f) => f.estado === e).length
  const data: Generado = {
    ruta: relativa(dir, archivo), formato: c.formato,
    llenos: cuenta("lleno"), faltantes: cuenta("faltante"), por_confirmar: cuenta("requiere_confirmacion"),
  }
  return { caso: c, filas, data, archivo }
}

export const generar_formulario = herramienta("proveedor_generar_formulario", {
  description: "Genera el formulario lleno en el formato del cliente (xlsx o pdf); para portal web deja los valores listos para copiar.",
  args: {
    caso: CASO,
    mapeo: z
      .object({
        confirmados: z.array(z.string()).describe("Etiquetas en requiere_confirmacion que el usuario aprobó explícitamente"),
      })
      .optional()
      .describe("Decisiones del usuario sobre el mapeo; los valores siempre se toman del maestro, nunca de aquí"),
  },
  run: async ({ caso, mapeo }, ctx) => {
    const confirmados = mapeo?.confirmados ?? (await confirmadosPrevios(ctx.directory, caso))
    const g = await generar(ctx.directory, caso, confirmados)
    // Se recuerdan las confirmaciones para que el paquete use el mismo formulario.
    await writeFile(path.join(rutas(ctx.directory).outCaso(caso), "confirmados.json"), JSON.stringify(confirmados))
    if (g.data.formato === "portal") {
      return falla(`formato no soportado: el cliente pide portal web. Se dejaron los valores listos para copiar en ${g.data.ruta}.`, g.data)
    }
    return ok(g.data)
  },
  resumen: (r) => (r.ok ? `${r.data.ruta} · ${r.data.llenos} llenos` : r.error),
})

// ---------- proveedor_armar_paquete (HU-4) ----------

function checklistMd(c: Caso, soportes: EstadoSoporte[], filas: Fila[], listo: boolean, fecha: string) {
  const icono = { presente: "✅ presente", ausente: "❌ ausente", vencido: "⛔ vencido" }
  const faltantes = filas.filter((f) => f.estado === "faltante")
  const porConfirmar = filas.filter((f) => f.estado === "requiere_confirmacion")
  return [
    `# Checklist — ${c.solicitud.cliente} (${c.solicitud.id})`,
    "",
    `Fecha de revisión: ${fecha} · Estado: **${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
    "",
    "## Soportes exigidos",
    "| Soporte | Estado | Vigencia hasta |",
    "|---|---|---|",
    ...soportes.map((s) => `| ${s.nombre} | ${icono[s.estado]} | ${s.vigencia_hasta ?? (s.estado === "ausente" ? "—" : "no vence")} |`),
    "",
    "## Campos faltantes (no bloquean la firma, RN3)",
    ...(faltantes.length ? faltantes.map((f) => `- ${f.campo.etiqueta}`) : ["- Ninguno"]),
    "",
    "## Campos que requieren confirmación",
    ...(porConfirmar.length ? porConfirmar.map((f) => `- ${f.campo.etiqueta}: ${f.nota ?? ""}`) : ["- Ninguno"]),
    "",
  ].join("\n")
}

/** Borrador para el cliente. Nunca incluye datos bancarios (RN2). */
function correoMd(c: Caso, adjuntos: string[], pendientes: string[]) {
  return [
    `**Para:** ${c.solicitud.de}`,
    `**Asunto:** RE: ${c.solicitud.asunto}`,
    "",
    "Buen día,",
    "",
    `En atención a su solicitud, Periferia IT Group S.A.S. remite el formulario de registro como proveedor diligenciado y firmado por el representante legal, junto con los siguientes soportes:`,
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    ...(pendientes.length ? ["Quedan pendientes y se enviarán por separado:", "", ...pendientes.map((p) => `- ${p}`), ""] : []),
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "Área Administrativa — Periferia IT Group S.A.S.",
    "",
    "---",
    "_Borrador generado por el agente. Requiere firma del representante legal y aprobación humana antes de enviarse._",
    "",
  ].join("\n")
}

export const armar_paquete = herramienta("proveedor_armar_paquete", {
  description: "Arma el paquete para firma (formulario, soportes, checklist y borrador de correo) e indica si está listo para firma.",
  args: { caso: CASO },
  run: async ({ caso }, ctx) => {
    const dir = ctx.directory
    const g = await generar(dir, caso, await confirmadosPrevios(dir, caso))
    const fecha = fechaEjecucion()
    const soportes = await revisarSoportes(dir, g.caso.soportes, fecha)
    const listo = soportes.every((s) => s.estado === "presente")
    const paquete = path.join(rutas(dir).outCaso(caso), "paquete")
    await rm(paquete, { recursive: true, force: true })
    await mkdir(paquete, { recursive: true })
    await copyFile(g.archivo, path.join(paquete, path.basename(g.archivo)))
    for (const s of soportes) {
      if (s.archivo) await copyFile(path.join(rutas(dir).soportes, s.archivo), path.join(paquete, s.archivo))
    }
    const adjuntos = [`Formulario (${path.basename(g.archivo)})`, ...soportes.filter((s) => s.estado === "presente").map((s) => s.nombre)]
    const pendientes = soportes.filter((s) => s.estado !== "presente").map((s) => `${s.nombre} (${s.estado})`)
    await writeFile(path.join(paquete, "checklist.md"), checklistMd(g.caso, soportes, g.filas, listo, fecha))
    await writeFile(path.join(paquete, "borrador-correo.md"), correoMd(g.caso, adjuntos, pendientes))
    const data = {
      ruta: relativa(dir, paquete),
      listo_para_firma: listo,
      fecha_revision: fecha,
      checklist: {
        soportes,
        campos_faltantes: g.filas.filter((f) => f.estado === "faltante").map((f) => f.campo.etiqueta),
        requiere_confirmacion: g.filas.filter((f) => f.estado === "requiere_confirmacion").map((f) => f.campo.etiqueta),
      },
      formulario: g.data,
    }
    await writeFile(path.join(paquete, "estado.json"), JSON.stringify(data, null, 2))
    return ok(data)
  },
  resumen: (r) => (r.ok ? `${r.data.ruta} · listo_para_firma=${r.data.listo_para_firma}` : r.error),
})

async function confirmadosPrevios(dir: string, caso: string): Promise<string[]> {
  try {
    const previo = JSON.parse(await readFile(path.join(rutas(dir).outCaso(caso), "confirmados.json"), "utf8"))
    return Array.isArray(previo) ? previo.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

// ---------- proveedor_simular_envio (HU-4, RN4) ----------

const EstadoPaquete = z.object({ ruta: z.string(), listo_para_firma: z.boolean(), checklist: z.object({ soportes: z.array(z.object({ nombre: z.string(), estado: z.string() })) }) })

export const simular_envio = herramienta("proveedor_simular_envio", {
  description: "Simula el envío del paquete (escribe ENVIO-SIMULADO.md); solo funciona con confirmación explícita del usuario en su último mensaje.",
  args: {
    caso: CASO,
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
  },
  run: async ({ caso, confirmado }, ctx: Ctx) => {
    if (!confirmado || !ctx.confirmacionUsuario) return falla("requiere confirmación explícita")
    const carpeta = rutas(ctx.directory).outCaso(caso)
    let estado: z.infer<typeof EstadoPaquete>
    try {
      estado = EstadoPaquete.parse(JSON.parse(await readFile(path.join(carpeta, "paquete", "estado.json"), "utf8")))
    } catch {
      return falla("No hay paquete armado para este caso. Primero arma el paquete.")
    }
    const c = await leerCaso(ctx.directory, caso)
    const archivo = path.join(carpeta, "ENVIO-SIMULADO.md")
    const alertas = estado.checklist.soportes.filter((s) => s.estado !== "presente").map((s) => `- ${s.nombre}: ${s.estado}`)
    await writeFile(archivo, [
      "# Envío simulado",
      "",
      `- Fecha: ${new Date().toISOString()}`,
      `- Destinatario: ${c.solicitud.de}`,
      `- Paquete: ${estado.ruta}`,
      `- Listo para firma al enviar: ${estado.listo_para_firma ? "sí" : "NO"}`,
      "- Confirmado explícitamente por el usuario: sí",
      ...(alertas.length ? ["", "## Advertencias al momento del envío", ...alertas] : []),
      "",
      "_Simulación: no se envió ningún correo real._",
      "",
    ].join("\n"))
    return ok({ ruta: relativa(ctx.directory, archivo), listo_para_firma: estado.listo_para_firma })
  },
  resumen: (r) => (r.ok ? r.data?.ruta ?? "ok" : r.error),
})
