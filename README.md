# Reto 01 — Agente conversacional "Registro como Proveedor"

Agente que lee la solicitud de registro de un cliente, llena el formulario desde el repositorio maestro (Excel o PDF), arma el paquete para firma con checklist y borrador de correo, y **pide confirmación humana** antes de cualquier envío (simulado).

- **Link de prueba:** https://reto01-arrieta.fly.dev
- **Clave de acceso del link:** se entrega en el correo de respuesta de la prueba (el front la pide una sola vez).
- Planteamiento completo de la solución: [`SOLUCION.md`](SOLUCION.md)

## Levantar en local (un comando)

Requisitos: Node 20+ (o Bun).

```bash
cp .env.example .env        # y pon tu ANTHROPIC_API_KEY
npm install && npm run dev  # → http://localhost:3000
```

Con Bun: `bun install && bun run src/server.ts`.

## Verificación sin modelo

```bash
npm install && npm run demo     # o: bun install && bun run demo.ts
```

Limpia `out/`, ejecuta las herramientas sobre los 4 casos de `fixtures/reto-01/casos/` e imprime un resumen por caso, los errores controlados y si el módulo reutilizable está sincronizado. No necesita ninguna clave.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí (solo para el chat) | Clave del modelo. Solo vive en el backend. |
| `LLM_MODEL` | No | Modelo, por defecto `claude-sonnet-5-5`. |
| `ACCESS_KEY` | No | Si se define, la API exige el header `x-access-key` (el front la pide). |
| `MAX_ITERACIONES` | No | Tope herramienta→modelo por turno (25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (400 000). |
| `MAX_SESIONES` | No | Máximo de sesiones simultáneas en memoria (200). |
| `LLM_TIMEOUT_MS` | No | Timeout al proveedor (90 000 ms). |
| `FECHA_EJECUCION` | No | Fecha `YYYY-MM-DD` para evaluar vencimientos; por defecto hoy (Bogotá). |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, error? }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión (mensajes y llamadas a herramientas) |
| `GET` | `/api/health` | `{ ok, provider, model, accessKeyRequired }` (sin claves) |

`toolCalls[]` = `{ nombre, args, ok, resumen }`. `sessionId`: 8–64 caracteres `[A-Za-z0-9_-]`.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/                  conocimiento: proceso (md) y reglas de negocio (json)
src/tools/proveedor.ts          herramientas (cada export → proveedor_<export>)
src/tools/_lib/                 dominio (mapeo, soportes) y escritura de formatos
src/llm/adapter.ts              interfaz propia del proveedor LLM
src/llm/anthropic.ts            implementación Anthropic
src/agente.ts                   ciclo del agente
src/server.ts                   API HTTP
web/index.html                  front de chat
demo.ts                         herramientas sin modelo
modulo/                         bonus: agente empaquetado (npm run modulo)
```

## Despliegue (Fly.io)

```bash
fly apps create reto01-arrieta
fly secrets set ANTHROPIC_API_KEY=... ACCESS_KEY=...
fly deploy
```
