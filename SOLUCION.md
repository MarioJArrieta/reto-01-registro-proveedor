# SOLUCIÓN — Reto 01 · Agente "Registro como Proveedor"

## 1. Problema en una frase

La analista administrativa transcribe a mano, en cada solicitud de registro como proveedor, datos que ya existen en el repositorio interno y busca los soportes uno por uno. Eso genera errores en datos sensibles (NIT, cuenta bancaria), depende de una persona y retrasa la facturación. **Le duele a la analista administrativa y, por los retrasos, a facturación.**

## 2. Arquitectura

```
┌───────────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ web/index.html    │ ────────────────▶ │ src/server.ts (node:http)                    │
│ - historial       │ ◀──────────────── │  - validación (zod), clave de acceso, topes  │
│ - tool calls      │  {reply,toolCalls,│  - sesiones en memoria                       │
│ - confirmación ⚠  │  needsConfirmation}│        │                                     │
└───────────────────┘                   │        ▼                                     │
                                        │ src/agente.ts  (ciclo del agente)            │
                                        │  prompt.md + knowledge ─▶ ProveedorLLM ─▶ API│
                                        │        │ llamadas                            │
                                        │        ▼                                     │
                                        │ src/tools/proveedor.ts  (zod, {ok,data})     │
                                        └────────┬───────────────────────┬─────────────┘
                                                 │ lectura               │ escritura
                                        fixtures/reto-01/          out/<caso>/ + out/log.jsonl
```

| Pieza | Dónde vive |
|---|---|
| **Comportamiento** | `agent/prompt.md` (reglas de conducta, orden de uso de herramientas, formato de respuesta). |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` (proceso, identificador por país, soportes) y `src/knowledge/reglas.json` (tabla país→identificador, umbrales de confianza, campos bancarios, nombres de soportes). Las herramientas leen `reglas.json`: cambiar una regla no toca el servidor ni el código. |
| **Ejecución** | `src/tools/proveedor.ts` (contrato), `src/tools/_lib/dominio.ts` (mapeo y soportes, lógica pura) y `src/tools/_lib/formatos.ts` (xlsx/pdf/portal). |
| **Proveedor LLM** | `src/llm/adapter.ts` (interfaz `enviar(mensajes, herramientas, sistema) → respuesta`) y `src/llm/anthropic.ts`. |

## 3. Ciclo del agente

`src/agente.ts → ejecutarTurno()`:

1. Agrega el mensaje del usuario a la sesión y arma el system prompt = `agent/prompt.md` + conocimiento.
2. Bucle: envía historial + definiciones de herramientas (JSON Schema generado desde los esquemas zod) al modelo.
   - Si el modelo pide herramientas, se ejecutan **en el backend**; cada herramienta valida sus argumentos con zod y devuelve `{ ok, data }` / `{ ok: false, error }`. **Nunca lanza.** El resultado vuelve al modelo y la llamada queda en el historial visible (CA4) y en `out/log.jsonl` + `out/<caso>/log.jsonl` (RN5).
   - Si responde solo texto, termina el turno.
3. **Topes (CA1 y costo):** `MAX_ITERACIONES` (25) por turno; al alcanzarlo responde con lo hecho y lo que falta. `MAX_TOKENS_SESION` por sesión y `MAX_SESIONES` en el servidor. Timeout configurable al proveedor.
4. **Errores (CA5):** si falla el proveedor (timeout, 401, 429, 5xx) se muestra un mensaje claro, el historial del turno se revierte para que la conversación siga siendo válida y la sesión no muere.

**Confirmación humana (CA3/RN4) — doble candado:**
- El prompt obliga a terminar con una pregunta y la marca `[CONFIRMACION]` cuando se necesita aprobación. El servidor la quita del texto, devuelve `needsConfirmation: true` y el front resalta el mensaje con botones Confirmar / Cancelar.
- El servidor solo marca `ctx.confirmacionUsuario = true` si el turno anterior pidió confirmación **y** el mensaje actual es una afirmación explícita ("sí", "confirmo", "envía"…). `proveedor_simular_envio` exige ese flag además de `confirmado: true`. **Aunque el modelo se equivoque y llame la herramienta, el envío no ocurre sin confirmación.** `demo.ts` lo demuestra: llamar `simular_envio` con `confirmado: true` sin confirmación del usuario devuelve `requiere confirmación explícita`.

**El modelo no puede inventar valores (CA2):** `generar_formulario` no recibe valores. Su argumento `mapeo` solo dice qué etiquetas aprobó el usuario. Los valores siempre se leen del maestro por su ruta. Así, aunque el modelo "alucine" un dato en el chat, no puede llegar al formulario.

## 4. Elección del modelo

- **Proveedor / modelo:** Anthropic, `claude-sonnet-5-5` (configurable con `LLM_MODEL`).
- **Por qué:** sigue bien instrucciones largas en español, usa herramientas de forma confiable en cadenas de 4–6 llamadas y tiene un costo medio. Un modelo pequeño (Haiku) también serviría porque el trabajo pesado lo hacen las herramientas deterministas; queda como optimización de costo.
- **Costo estimado por caso:** un caso completo son unas 5 llamadas al modelo con ~6–10 mil tokens de entrada cada una (prompt + herramientas + historial) y ~2 mil de salida en total. Con una tarifa de referencia de 3 USD por millón de tokens de entrada y 15 USD por millón de salida, son **≈ 0,10–0,20 USD por caso**, menos con el cacheo del system prompt (activado). Con 8–12 solicitudes al mes: **< 3 USD/mes**. *Verificar la tarifa vigente del modelo elegido.*

## 5. Diseño del formato "portal web" (sección 7.4)

**Hoy:** `generar_formulario` responde `formato no soportado` y escribe `out/<caso>/valores-portal.md` con una tabla campo / valor / estado lista para copiar. El paquete y el checklist se arman igual.

**Propuesta para producción:**
- **Estrategia:** navegador controlado por el agente con **Playwright**, en modo *asistido*. Por cada portal, un "perfil" versionado (selectores por etiqueta accesible, no por posición) que mapea etiqueta → campo del maestro. El agente navega y llena; si un selector no aparece (cambio de layout), se detiene y devuelve la tabla copiable. Descartado RPA de escritorio (frágil y costoso) y extensión de navegador (difícil de distribuir y auditar).
- **Límites:** CAPTCHA y MFA **no se evaden**: el navegador se abre en modo visible y la persona los resuelve. Cambios de layout → detección por fallo de selector, captura de pantalla y regreso al modo copiar/pegar. Cargas de archivos: el agente adjunta los soportes del paquete.
- **Credenciales:** nunca en el repo, el prompt, los logs ni la memoria del modelo. Opción 1 (preferida): la analista inicia sesión ella misma en la ventana del navegador; el agente trabaja sobre la sesión ya abierta. Opción 2: un gestor de secretos (Azure Key Vault / 1Password) que inyecta la credencial directamente en el campo del navegador sin pasar por el modelo. Los logs enmascaran inputs de tipo password.
- **Humano vs. agente:** el humano ingresa credenciales, resuelve CAPTCHA/MFA, revisa la pantalla final y hace **clic en "Enviar"**. El agente navega, llena campos, adjunta soportes y toma captura de evidencia antes del envío.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Mapeo **determinista** (glosario exacto → similitud de palabras con umbrales) dentro de la herramienta. | Que el modelo decida el mapeo campo a campo. | Trazable, reproducible en `demo.ts`, sin costo y sin riesgo de valores inventados. El modelo explica y conversa; no decide los datos. |
| `generar_formulario` recibe solo **etiquetas aprobadas**, nunca valores. | Recibir el mapeo completo con valores, como sugiere el contrato. | Hace imposible que un valor alucinado llegue al formulario (CA2 "por diseño"). |
| Confirmación verificada **en el servidor** además del prompt. | Confiar solo en el prompt. | RN4 es una regla de seguridad; un prompt se puede saltar y un candado en el código no. |
| `node:http` + HTML plano. | Express/Next/React. | Menos dependencias y arranque inmediato; el front es una sola pantalla. |
| `fetch` directo a la API de Anthropic. | SDK oficial. | Una dependencia menos y control total del mapeo en el adaptador; cambiar de proveedor = otro archivo. |
| PDF generado con `pdf-lib`. | Rellenar un AcroForm. | El PRD lo acepta y no se entregó un PDF fuente con campos. |
| Sesiones en memoria. | Base de datos / archivos. | Fuera de alcance (no-objetivo). Se pierden al reiniciar; aceptable para el reto. |

Dependencias: `zod` (obligatorio), `exceljs` (escribir xlsx en celdas exactas), `pdf-lib` (PDF sin binarios nativos), `tsx` (ejecutar TypeScript en Node 20+). Desarrollo: `typescript`, `@types/node`.

## 7. Supuestos

1. **Fecha de ejecución = hoy (zona Bogotá).** Con la fecha real (oct-2026) la Cámara de Comercio (vence 2026-09-30) y los parafiscales (2026-08-31) quedan **vencidos**, así que ningún caso está listo para firma. Para reproducir otra fecha: `FECHA_EJECUCION=2026-09-03`.
2. Un campo `requiere_confirmacion` por **RN1** (identificador extranjero) se **escribe** con el NIT y se marca (nota en la celda de Excel, texto en el PDF). Uno por **baja confianza** queda vacío hasta que el usuario lo apruebe.
3. "Identificación tributaria" y "Número de identificación fiscal" son etiquetas ambiguas: incluso en Colombia quedan en `requiere_confirmacion` con la propuesta del país.
4. Un soporte exigido que no existe en el índice (p. ej. *certificado de cumplimiento tributario*) es **ausente** y bloquea la firma (RN3).
5. El caso `portal` trae `plantilla-campos.json`; se usa para preparar los valores copiables.
6. El envío simulado se permite aunque el paquete no esté listo, siempre que el usuario lo confirme **después** de que el agente le advierta; `ENVIO-SIMULADO.md` registra el estado y las alertas.
7. Los valores se escriben tal cual están en el maestro (p. ej. `País = CO`, ingresos sin formato) para no transformar datos.
8. "Referencias comerciales" y "Número de contribuyente especial" no existen en el maestro → **faltantes**.

## 8. Cobertura

| HU | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer solicitud | Hecho | Lee correo, plantilla xlsx/pdf, soportes y reporta ambiguos. Producción: leer el correo real y el Excel/PDF del cliente (hoy son JSON normalizados). |
| HU-2 Mapear campos | Hecho | Tres estados con ruta y confianza; glosario; nunca inventa. Producción: glosario administrado por negocio y aprendizaje de nuevos sinónimos aprobados. |
| HU-3 Generar formulario | Hecho (P0 xlsx, P1 pdf, P2 portal como valores copiables) | Producción: escribir sobre la plantilla original del cliente (conservar formato) y rellenar AcroForms. |
| HU-4 Paquete para firma | Hecho | Formulario, soportes, checklist, borrador sin datos bancarios, envío simulado con confirmación. Producción: firma electrónica y envío real. |
| HU-5 Errores | Hecho | Caso inexistente, plantilla corrupta, formato no soportado, argumentos inválidos, errores del proveedor LLM: mensajes claros, sin trazas. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas fuentes (`npm run modulo`); `demo.ts` verifica que esté sincronizado. |

## 9. Uso de IA

- **Claude Code (modelo Claude Opus 5.5)** como asistente de programación: lectura del PRD y los fixtures, propuesta de la estructura del proyecto, borradores del código de las herramientas, del ciclo del agente, del front y de esta documentación. Revisé y ajusté cada parte, y verifiqué el comportamiento con `demo.ts` y pruebas manuales en el chat.
- **Qué descarté o corregí de lo propuesto:**
  - Que el modelo hiciera el mapeo o enviara valores a `generar_formulario`. Lo cambié por mapeo determinista y "solo etiquetas aprobadas" para cumplir CA2 por diseño.
  - Un umbral de similitud de 0,5 que convertía "Referencias comerciales" en candidato de "Contacto comercial". Lo subí a 0,6 para que quede como faltante.
  - Confiar solo en el prompt para la confirmación. Agregué el candado en el servidor.
  - Usar Express y el SDK oficial. Los descarté para reducir dependencias.
- **En producción (el agente):** Claude Sonnet vía API de Anthropic.

## 10. Riesgos de llevarlo a producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo afirma en el chat un valor que no salió de una herramienta. | Prompt lo prohíbe; el formulario no acepta valores del modelo; revisión humana del paquete antes de firmar. Evaluaciones automáticas sobre conversaciones de prueba. |
| Datos sensibles (cuenta bancaria, cédula) en logs y en el proveedor del modelo. | Los logs solo guardan resúmenes; enmascarar números de cuenta en `resumen`; contrato de tratamiento de datos con el proveedor del modelo (sin retención). |
| Maestro desactualizado → formularios con datos viejos. | Dueño del dato y fecha de última actualización en el maestro; alerta si supera N días. |
| Plantillas reales más variadas (Excel con celdas combinadas, PDF escaneados). | Lectura de la plantilla real con detección de etiquetas y confianza; cuando la confianza es baja, `requiere_confirmacion`. |
| Abuso del link / costo de la clave. | `ACCESS_KEY`, topes por turno, por sesión y de sesiones; en producción, autenticación corporativa (Entra ID) y cuotas por usuario. |
| Sesiones en memoria se pierden al reiniciar. | Persistir sesiones (Redis / archivos) y logs centralizados. |
| Portales con CAPTCHA / MFA. | Modo asistido: el humano opera las partes de seguridad (sección 5). |
