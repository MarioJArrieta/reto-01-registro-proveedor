// Interfaz propia del proveedor de modelo. El ciclo del agente solo conoce estos tipos,
// así que cambiar de proveedor es escribir otra implementación de `ProveedorLLM`.

export type Bloque =
  | { tipo: "texto"; texto: string }
  | { tipo: "llamada"; id: string; nombre: string; args: Record<string, unknown> }
  | { tipo: "resultado"; id: string; contenido: string; error: boolean }

export type Mensaje = { rol: "usuario" | "asistente"; bloques: Bloque[] }

export type DefinicionHerramienta = {
  nombre: string
  descripcion: string
  /** JSON Schema de los argumentos (generado desde zod). */
  esquema: Record<string, unknown>
}

export type Respuesta = {
  bloques: Bloque[]
  uso: { entrada: number; salida: number }
}

export interface ProveedorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], sistema: string): Promise<Respuesta>
}

/** Error del proveedor con un mensaje apto para mostrar al usuario (sin claves ni trazas). */
export class ErrorLLM extends Error {}
