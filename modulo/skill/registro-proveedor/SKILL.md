---
name: registro-proveedor
description: Conocimiento del proceso de registro de Periferia IT Group como proveedor ante clientes de Colombia, Ecuador, Perú, Panamá y Honduras; úsalo al preparar formularios, soportes y paquetes para firma.
---
# Registro como proveedor — conocimiento del proceso

## Flujo
1. Recepción deja la solicitud del cliente (correo + plantilla) en la carpeta de entrada.
2. La analista pide al agente procesar el caso.
3. El agente llena el formulario desde el repositorio maestro, arma el paquete y reporta faltantes.
4. La analista revisa y aprueba. El representante legal firma. El envío al cliente es una decisión humana.

## Formatos de salida
- **xlsx**: se escribe cada etiqueta y su valor en la hoja y celda que indica la plantilla del cliente.
- **pdf**: se genera un PDF con todos los campos en el orden de la plantilla.
- **portal web**: no se automatiza. Se entregan los valores listos para copiar; credenciales y clic en "Enviar" son humanos.

## Identificador tributario por país (RN1)
| País | Identificador |
|---|---|
| Colombia (CO) | NIT |
| Ecuador (EC) | RUC |
| Perú (PE) | RUC |
| Panamá (PA) | RUC |
| Honduras (HN) | RTN |

Periferia solo tiene NIT colombiano. Para clientes de otros países el campo se llena con el NIT y queda en **requiere confirmación** con la nota "identificador extranjero".

## Estados de un campo
- **lleno**: el dato existe en el maestro (se indica la ruta, p. ej. `representante_legal.nombre`).
- **faltante**: no existe en el maestro. Nunca se inventa. No bloquea la firma, pero aparece en el checklist.
- **requiere confirmación**: coincidencia con confianza < 0.8 o regla de país.

## Soportes (RN3)
- Un soporte exigido **ausente** o **vencido** (vigencia anterior a la fecha de ejecución) bloquea "listo para firma".
- La Cámara de Comercio suele exigirse con máximo 30 días de expedición: si está vencida, hay que solicitar una nueva.
- Los parafiscales se certifican mensualmente.

## Datos sensibles (RN2)
Los datos bancarios solo se llenan si la plantilla los pide explícitamente y nunca van en el borrador de correo.

## Acciones externas (RN4)
Ninguna acción externa (envío, firma, carga a portal) sin confirmación explícita del usuario en el turno inmediatamente anterior. En esta versión "enviar" solo escribe `ENVIO-SIMULADO.md`.
