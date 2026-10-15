# Pacientes locales

## Uso

Reiniciar el server local y abrir **Pacientes**. Ingresar nombre, edad opcional
(0–150 años), fecha de ingreso opcional y notas (hasta 120 caracteres).
El mismo formulario permite asignar un llamador; si está ocupado solicita
confirmación. Desasignar o eliminar limpia el paciente del llamador.
**Reenviar** permite solicitar nuevamente la sincronización.

La asignación es 1:1 y transaccional. Los llamados y las asignaciones de lámparas
continúan con su lógica existente. SQLite conserva los pacientes y utiliza UUID
como ID; `assignedDevice` identifica el llamador. La sincronización con pacientes
de Firestore se implementará en la futura integración con Clinum.

## Actualización de firmware

Compilar y cargar los proyectos:

- `gw-esp32-s3-now-lora`: gateway.
- `call-lcd-2.8-h1-in-esp32_s3-now-lora`: táctil.
- `call-lcd-2.8-v1-in-esp32_s3-now-lora`: táctil vertical (VLN-7.9.6).
- `rp-esp32-c3-now`: repetidor, si el táctil utiliza esta ruta.

El táctil utiliza la partición configurada en `iot_config.h`:
**16 MB / app3M_fat9M_16MB**, con PSRAM OPI. Conservar los parámetros de
hardware/provisionamiento del dispositivo al cargarlo.

El protocolo nuevo no modifica CONFIG ni los frames de llamado/lámpara.
Envía JSON UTF-8 en fragmentos binarios de 85 bytes por ESP-NOW o líneas `PAT`
hexadecimales por LoRa (menos de 199 bytes). El táctil aplica los datos solamente
cuando tiene todos los fragmentos y confirma con CONFIG_ACK. El gateway espacia
los fragmentos sin bloquear su loop de eventos. El server reintenta los envíos
pendientes cada 45 s y al registrarse el dispositivo. El táctil conserva los datos
en NVS y actualiza nombre en reposo/llamado y ficha del paciente.

## Verificación en dispositivos

1. Crear “José Pérez”, edad 30, fecha y notas con tildes y comas; asignar a un táctil.
2. Verificar nombre en reposo y ficha con los cuatro campos.
3. Iniciar llamado normal y emergencia; comprobar nombre también en monitor y sala,
   contador, cronómetro y lámparas.
4. Reiniciar el táctil y comprobar ficha restaurada y reconexión.
5. Mover el paciente a otro llamador: limpiar el anterior y llenar el nuevo.
6. Desasignar/eliminar: comprobar limpieza en táctil y sala sin cerrar el llamado.
7. Repetir por LoRa y por repetidor ESP-NOW, si se utilizan.
8. Interrumpir la radio durante envío y recuperarla: esperar el reintento o usar
   Reenviar; nunca debe aplicarse una ficha incompleta.

Las pruebas automatizadas se ejecutan con `npm run build` y `npm test`.
