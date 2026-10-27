// Implementación de ProveedorLLM para la API de Anthropic (Messages API) usando fetch, sin SDK.
import { ErrorLLM, type Bloque, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type Respuesta } from "./adapter.ts"

type BloqueApi =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }

type RespuestaApi = {
  content: BloqueApi[]
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
  error?: { message: string }
}

function aApi(b: Bloque): BloqueApi {
  if (b.tipo === "texto") return { type: "text", text: b.texto }
  if (b.tipo === "llamada") return { type: "tool_use", id: b.id, name: b.nombre, input: b.args }
  return { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.error }
}

function desdeApi(b: BloqueApi): Bloque | null {
  if (b.type === "text") return { tipo: "texto", texto: b.text }
  if (b.type === "tool_use") return { tipo: "llamada", id: b.id, nombre: b.name, args: b.input }
  return null
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly proveedor = "anthropic"

  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly maxTokensRespuesta = 2048,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], sistema: string): Promise<Respuesta> {
    const cuerpo = {
      model: this.modelo,
      max_tokens: this.maxTokensRespuesta,
      system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral" } }],
      tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema })),
      messages: mensajes.map((m) => ({ role: m.rol === "usuario" ? "user" : "assistant", content: m.bloques.map(aApi) })),
    }
    let res: Response
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.clave, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
      throw new ErrorLLM(timeout ? `El modelo no respondió en ${this.timeoutMs / 1000} s. Intenta de nuevo.` : "No se pudo conectar con el proveedor del modelo.")
    }
    const datos = (await res.json().catch(() => ({}))) as RespuestaApi
    if (!res.ok) throw new ErrorLLM(mensajeHttp(res.status, datos.error?.message))
    return {
      bloques: datos.content.map(desdeApi).filter((b): b is Bloque => b !== null),
      uso: { entrada: datos.usage?.input_tokens ?? 0, salida: datos.usage?.output_tokens ?? 0 },
    }
  }
}

function mensajeHttp(status: number, detalle?: string): string {
  if (status === 401) return "La clave del proveedor del modelo no es válida (revisa ANTHROPIC_API_KEY en el servidor)."
  if (status === 429) return "El proveedor del modelo está limitando las solicitudes. Espera unos segundos e intenta de nuevo."
  if (status === 529 || status >= 500) return "El proveedor del modelo está saturado o caído en este momento. Intenta de nuevo."
  return `El proveedor del modelo rechazó la solicitud (${status})${detalle ? `: ${detalle}` : ""}.`
}
