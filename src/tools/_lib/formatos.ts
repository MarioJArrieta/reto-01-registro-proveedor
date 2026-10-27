// Escritura del formulario en el formato que pidió el cliente (xlsx, pdf o valores para portal).
import { writeFile } from "node:fs/promises"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { CampoSolicitado, Solicitud } from "./dominio.ts"

/** Una fila del formulario ya resuelta: el valor siempre proviene del maestro (o queda vacío). */
export type Fila = {
  campo: CampoSolicitado
  valor: string
  estado: "lleno" | "faltante" | "requiere_confirmacion"
  nota?: string
}

export async function escribirXlsx(archivo: string, filas: Fila[]) {
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro como Proveedor"
  for (const f of filas) {
    const c = f.campo.celda
    if (!c) continue
    const hoja = libro.getWorksheet(c.hoja) ?? libro.addWorksheet(c.hoja)
    hoja.getCell(c.celda_etiqueta).value = c.etiqueta
    hoja.getCell(c.celda_etiqueta).font = { bold: true }
    const celda = hoja.getCell(c.celda_valor)
    celda.value = f.valor || null
    if (f.estado !== "lleno") {
      celda.note = f.estado === "faltante" ? "FALTANTE: no existe en el repositorio maestro." : `REQUIERE CONFIRMACIÓN: ${f.nota ?? ""}`
      celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: f.estado === "faltante" ? "FFFDE2E2" : "FFFFF4CC" } }
    }
  }
  libro.eachSheet((h) => h.columns.forEach((col) => (col.width = 42)))
  await libro.xlsx.writeFile(archivo)
}

// ---------- PDF ----------

type Lienzo = { doc: PDFDocument; pagina: PDFPage; y: number; normal: PDFFont; negrita: PDFFont }

const MARGEN = 50
const ANCHO = 595.28
const ALTO = 841.89

function nuevaPaginaSiHaceFalta(l: Lienzo, alto: number) {
  if (l.y - alto > MARGEN) return
  l.pagina = l.doc.addPage([ANCHO, ALTO])
  l.y = ALTO - MARGEN
}

function partir(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(/\s+/)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  if (actual) lineas.push(actual)
  return lineas
}

function texto(l: Lienzo, t: string, tam: number, fuente: PDFFont, color = rgb(0.1, 0.1, 0.15)) {
  for (const linea of partir(t, fuente, tam, ANCHO - 2 * MARGEN)) {
    nuevaPaginaSiHaceFalta(l, tam + 4)
    l.pagina.drawText(linea, { x: MARGEN, y: l.y, size: tam, font: fuente, color })
    l.y -= tam + 4
  }
}

export async function escribirPdf(archivo: string, filas: Fila[], sol: Solicitud) {
  const doc = await PDFDocument.create()
  doc.setTitle(`Formulario de proveedor - ${sol.cliente}`)
  const l: Lienzo = {
    doc, pagina: doc.addPage([ANCHO, ALTO]), y: ALTO - MARGEN,
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  texto(l, "Formulario de registro / calificación de proveedor", 16, l.negrita)
  texto(l, `Cliente: ${sol.cliente}  ·  Solicitud: ${sol.id}  ·  Adjunto original: ${sol.adjuntos.join(", ") || "-"}`, 9, l.normal, rgb(0.35, 0.35, 0.4))
  l.y -= 10
  for (const f of filas) {
    nuevaPaginaSiHaceFalta(l, 40)
    texto(l, `${f.campo.etiqueta}${f.campo.obligatorio ? " *" : ""}`, 10, l.negrita)
    const valor = f.valor || (f.estado === "faltante" ? "(faltante en el repositorio maestro)" : "(pendiente de confirmación)")
    texto(l, valor, 11, l.normal, f.valor ? rgb(0.05, 0.05, 0.1) : rgb(0.7, 0.1, 0.1))
    if (f.estado === "requiere_confirmacion") texto(l, `Requiere confirmación: ${f.nota ?? ""}`, 8, l.normal, rgb(0.6, 0.4, 0))
    l.y -= 6
  }
  l.y -= 30
  texto(l, "* Campo obligatorio", 8, l.normal, rgb(0.35, 0.35, 0.4))
  l.y -= 30
  texto(l, "______________________________________", 11, l.normal)
  texto(l, "Firma del representante legal", 10, l.negrita)
  await writeFile(archivo, await doc.save())
}

// ---------- Portal web (no soportado: valores listos para copiar) ----------

export async function escribirValoresPortal(archivo: string, filas: Fila[], sol: Solicitud) {
  const esc = (s: string) => s.replace(/\|/g, "\\|")
  const md = [
    `# Valores para el portal — ${sol.cliente}`,
    "",
    "> El formato **portal web** no se llena automáticamente. Copia estos valores en el portal.",
    "> Las credenciales las ingresa una persona; nunca se guardan aquí.",
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas.map((f) => `| ${esc(f.campo.etiqueta)} | ${esc(f.valor || "—")} | ${f.estado}${f.nota ? `: ${esc(f.nota)}` : ""} |`),
    "",
  ].join("\n")
  await writeFile(archivo, md)
}
