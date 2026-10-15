# Confiabilidad Clinum — entrega candidata para piloto

## Componentes

| Proyecto | Versión candidata |
|---|---|
| Gateway | GW-4.4.0 |
| Táctil horizontal | HLN-7.10.0 |
| Táctil vertical | VLN-7.10.0 |
| Capacitivo | CLN-2.3.0 |
| Lámpara | NL-7.4.0 |
| Repetidor | RPT-2.22.0 (se verifica compatibilidad) |

Los archivos comunes `reliable_outbox.h`, `lcd_reliable_adapter.h` y
`lora_tx_scheduler.h` viven en `call-cap-now-lora-esp32_c3`. Mantener los proyectos
en su estructura de carpetas al compilar: los otros proyectos los incluyen.

## Implementado

- Registro SQLite de recibos exactos: duplicado aplicado != mensaje antiguo.
- Evento, secuencia y recibo se guardan en una transacción antes del ACK.
- Identidad de llamado dirigida para evitar cerrar uno nuevo con un cierre viejo.
- Outbox NVS de 64 eventos en los tres llamadores. Ocho posiciones reservadas
  para finalización; si no puede guardarse, la acción no se confirma.
- Normal/emergencia y finalización pendiente sobreviven al reinicio.
- Especiales reintentan y confirman por ACK del servidor, pero no se guardan
  para recuperación después de reiniciar.
- Rechazo explícito antiguo: auditado en NVS, no se presenta como entrega exitosa.
- Pantallas muestran pendiente; especial muestra recibido solo al ACK.
- Capacitivo diferencia pendiente con indicador ámbar y confirmación sonora.
- Cierres y nombres pendientes en SQLite, reintentos y confirmación específica.
- Nombre del servidor tiene prioridad; primer registro usa nombre del dispositivo.
  CONFIG actual admite 32 bytes UTF-8, sin comas/saltos (CSV antiguo).
- Palpito dispositivos 50–70 s; consulta bidireccional gateway cada 2 s.
- Reconexión serial automática y server disponible aunque gateway esté desconectado.
- LoRa: cola de 32 comandos, un comando en vuelo hasta +OK, reintentos de errores,
  reserva para tráfico clínico y prioridad sobre pacientes/palpitos.
- Último relay exitoso se conserva como candidato; la ruta se valida de nuevo.
- Lámpara no considera driver ESP_OK una confirmación del servidor; permite
  reintentos del origen y reenvío de confirmaciones CONFIG/pacientes.
- Diagnóstico en Configuración y `/network/diagnostics`.

## Compatibilidad y orden de actualización

1. Respaldar SQLite y conservar los binarios anteriores para retorno.
2. Actualizar servidor y gateway antes de los llamadores nuevos.
3. Actualizar un táctil horizontal, un vertical, un capacitivo y una lámpara.
4. Mantener provisionamiento, nombres, pacientes y particiones existentes.
5. Ejecutar la matriz física antes de extender al parque.

Los nuevos llamados usan el bit alto de `isEmergency` como marca de identidad
estable y `sentAtMs` como callId; tamaño de frame no cambia. LoRa agrega un token
opcional callId. El gateway nuevo sigue aceptando los frames antiguos.
**Los nuevos llamadores requieren gateway actualizado**, para interpretar la marca.
Las confirmaciones antiguas 0/1/2 se conservan; resultado 3 indica antiguo no aplicado.

Arduino ESP32 core validado: 3.3.6. Táctiles: esp32s3, PSRAM OPI, flash16M,
app3M_fat9M_16MB. Capacitivo/lámpara: XIAO ESP32C3, min_spiffs.

## Pruebas reproducibles

Server: `npm run build` y `npm test`.
Outbox y scheduler reales con NVS/UART simulados:
`tests\firmware-host\run.cmd` (MSVC BuildTools 2019, salidas en `%TEMP%\opencode`).
Se comprueba reinicio, exclusión de especiales, fallo de escritura, ACK incorrecto,
capacidad reservada, comandos LoRa prioritarios, espera +OK, +ERR y timeout.

## Matriz física obligatoria para salida a producción

Para cada llamador, por NOW directo, NOW vía nodo y LoRa:

1. Registrar, editar nombre, apagar/prender, verificar paciente y desasignación.
2. Normal, emergencia e insistencia: confirmar mismo llamado en servidor/lámpara.
3. Cortar comunicación antes del evento y después del guardado (ACK perdido).
4. Reiniciar con evento pendiente y con llamado confirmado activo.
5. Finalizar desde llamador sin red; recuperar y comprobar cierre único.
6. Finalizar desde servidor con llamador apagado; prender y comprobar cierre.
7. Retrasar cierre anterior y comenzar otro llamado: el nuevo no debe cerrarse.
8. Especial: Enviando -> ACK -> Recibido. Reiniciar mientras está pendiente:
   no debe reenviarse ni recuperarse. Especial recibido sigue en el servidor.
9. Desconectar USB del gateway y recuperarlo: server y pendientes continúan.
10. Ráfagas de 10, 20 y 50 dispositivos, con pacientes en paralelo: medir latencia
    P50/P95/P99, colas, errores AT, eventos pendientes/rechazados.

Conservar evidencia de cada prueba. Compilar y probar en host no demuestra
el alcance ni la latencia RF en la sede.

## Siguiente etapa de arquitectura

La entrega candidata no habilita aún puentes simultáneos NOW↔LoRa. Esa función
requiere ambos módulos, perfiles independientes autorizados, identidad de origen,
TTL, rutas inversas y pruebas de bucles. Se mantiene estrella LoRa y relay NOW.
Tampoco se cambia automáticamente SF/BW/potencia: optimización RF según mediciones.
El perfil capacitivo a batería queda para el diseño futuro indicado por el usuario.
