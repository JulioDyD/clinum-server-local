# Plan de seguridad para ESP-NOW

## Estado del documento

- Estado: pendiente de implementación.
- Alcance: terminales, gateway y tráfico relay ESP-NOW.
- Objetivo: impedir suplantación, modificación y repetición de mensajes, y
  reducir la exposición de datos y secretos.
- Este documento no modifica el comportamiento actual del firmware.
- La implementación debe hacerse de forma coordinada en terminal y gateway.

## Riesgos confirmados en la versión actual

1. Los peers se registran con `encrypt = false`.
2. La MAC y `deviceId` identifican un equipo, pero no autentican al emisor.
3. `ACK`, `CONFIG`, `HEARTBEAT`, `RELAY_REQ` y `RELAY_CONFIRM` se procesan sin
   firma criptográfica.
4. Un contador `seq` sin firma puede ser falsificado con un valor mayor.
5. Un frame recibido puede modificar reloj, conectividad, rutas, configuración
   o estado de llamada antes de demostrar que proviene de un nodo autorizado.
6. El broadcast requerido para descubrimiento y relay no proporciona seguridad
   de extremo a extremo.
7. El acceso técnico oculto por pulsación prolongada facilita mantenimiento,
   pero no constituye autenticación.

## Política obligatoria

### Autenticación e integridad

- Todo frame operativo debe llevar autenticación criptográfica de aplicación.
- Usar HMAC-SHA-256 y truncar el resultado a 16 bytes como mínimo.
- El HMAC debe cubrir el encabezado completo y el payload, incluidos versión,
  red, emisor, receptor, tipo, contador y longitud.
- Comparar tags en tiempo constante.
- CRC, checksum, MAC de radio y `deviceId` no sustituyen el HMAC.
- Un frame no autenticado nunca debe alterar estado ni generar una respuesta
  que confirme información interna.

### Confidencialidad

- Si un frame contiene datos clínicos, credenciales o configuración sensible,
  usar cifrado autenticado AES-GCM o ChaCha20-Poly1305.
- El nonce debe ser único para cada mensaje enviado con una misma clave.
- Nunca reutilizar pares clave/nonce.
- Los heartbeats y las métricas pueden quedar visibles únicamente si no
  contienen datos sensibles, pero siempre deben estar autenticados.

### Claves

- Cada terminal debe tener una clave única; no usar una clave global en toda la
  instalación.
- Separar las claves por dirección y propósito mediante HKDF:
  `terminal-to-gateway`, `gateway-to-terminal`, `admin-config` y, si se adopta,
  `relay-hop`.
- No guardar claves reales en Git, logs, etiquetas de UI ni documentación.
- No usar la MAC, `deviceId`, un PIN corto o el nombre de la institución como
  clave.
- Definir procedimientos de aprovisionamiento, respaldo, rotación, revocación
  y reemplazo de equipos.
- La pérdida de un terminal debe permitir revocar solo ese terminal.
- En producción, proteger claves y firmware con Secure Boot y Flash Encryption
  del ESP32.

### Antireplay

- Usar contador monotónico de 64 bits por emisor y dirección.
- Reservar rangos en NVS para evitar reutilización después de reinicios o
  pérdidas de energía.
- El receptor debe conservar el mayor contador confirmado por cada emisor.
- Verificar el HMAC antes de evaluar o actualizar el contador recibido.
- Un duplicado válido puede recibir respuesta `DUPLICATE`, pero su acción no se
  debe ejecutar otra vez.
- Un contador menor o igual al último aceptado debe rechazarse, salvo dentro de
  una ventana antireplay explícitamente diseñada y probada.
- Incluir un identificador de época de aprovisionamiento para poder reiniciar
  contadores únicamente después de una reprovisión autorizada.

## Parámetros iniciales propuestos

Estos valores deben centralizarse en el protocolo compartido y revisarse antes
de producción:

| Parámetro | Valor inicial |
|---|---:|
| Versión segura de protocolo | `2` |
| Identificador de red | `uint32_t`, único por instalación |
| Contador de mensaje | `uint64_t` |
| Tag HMAC | 16 bytes |
| Clave raíz por dispositivo | 32 bytes aleatorios |
| Nonce AEAD, si se cifra | 12 bytes |
| Tag AEAD | 16 bytes |
| TTL relay máximo | conservar el actual, con límite `1..4` |
| Ventana de rate limit inicial | 10 segundos |
| Bloqueo temporal por abuso | 60 segundos |
| Reserva de contadores NVS | mínimo 100000 valores |

El `networkId` no es secreto. Su función es impedir que instalaciones distintas
acepten mensajes entre sí. Debe generarse durante el aprovisionamiento y no
derivarse de un nombre público.

## Formato lógico de frame seguro

El formato definitivo debe residir en el archivo de protocolo compartido por
terminal y gateway. No se debe serializar un `String` ni depender de padding del
compilador.

```cpp
struct __attribute__((packed)) EspNowSecureHeader {
    uint8_t  protocolVersion;
    uint8_t  msgType;
    uint16_t flags;
    uint32_t networkId;
    uint8_t  senderId[6];
    uint8_t  recipientId[6];
    uint32_t provisioningEpoch;
    uint64_t counter;
    uint16_t payloadLength;
};

struct __attribute__((packed)) EspNowAuthTrailer {
    uint8_t tag[16];
};
```

Reglas del formato:

- Definir explícitamente el orden de bytes de enteros para terminal y gateway.
- Validar que `payloadLength` coincide exactamente con los bytes recibidos.
- Rechazar campos reservados, versiones y tipos desconocidos.
- Añadir `static_assert` para tamaños y límites de cada frame.
- Verificar que cada frame completo cabe en el máximo admitido por la versión
  de ESP-NOW y del core ESP32 realmente utilizados.
- No enviar memoria de structs que contenga punteros, padding no controlado o
  datos sin inicializar.

## Orden obligatorio de recepción

`onEspNowRecv()` debe delegar en un verificador común. El orden será:

1. Validar punteros, longitud mínima y longitud máxima.
2. Copiar a una estructura local; no procesar directamente desde el buffer.
3. Validar versión, `networkId`, tipo, flags y longitud declarada.
4. Identificar al emisor y localizar su clave y permisos.
5. Verificar HMAC o tag AEAD en tiempo constante.
6. Validar época de aprovisionamiento y contador antireplay.
7. Validar que el emisor está autorizado para el tipo de mensaje.
8. Registrar el contador aceptado de forma resiliente.
9. Solo entonces actualizar estado, encolar trabajo, reenviar o responder.

Antes de completar esos pasos está prohibido modificar:

- `lastGatewayAckMs`, `lastDirectGatewayAckMs` o `espnowServerSynced`.
- Reloj del sistema o información de restauración de llamada.
- `relayPeers`, rutas inversas, tablas hop o métricas de gateway.
- `espnowPendingConfig`, preferencias NVS o estado visual de llamada.
- Confirmaciones ACK/relay y máquinas de estado de transmisión.

## Autorización por tipo de mensaje

| Mensaje | Emisor autorizado | Receptor autorizado |
|---|---|---|
| `CALL_START`, `CALL_INSIST`, `CALL_END` | Terminal asignado | Gateway |
| `REGISTER`, `HEARTBEAT` | Terminal aprovisionado | Gateway o relay autorizado |
| `ACK` | Gateway | Terminal destinatario |
| `CONFIG` | Gateway con permiso administrativo | Terminal destinatario |
| `CONFIG_ACK` | Terminal destinatario | Gateway |
| `RELAY_REQ` | Terminal aprovisionado | Relay autorizado |
| `RELAY_CONFIRM` | Relay autorizado | Hop anterior u origen |

Una MAC de origen permitida es una comprobación adicional, no la autoridad
principal. La identidad válida es la que demuestra posesión de la clave.

## Política específica para relay

- Conservar autenticación de extremo a extremo entre terminal y gateway.
- Un relay no debe modificar el payload original ni su tag de extremo a extremo.
- Los campos mutables de enrutamiento (`ttl`, `prevHopMac`, `relaySeq`) deben
  protegerse por separado con autenticación por salto, o trasladarse a un
  encabezado externo autenticado por cada hop.
- Autenticar heartbeats antes de usarlos para seleccionar rutas.
- Autenticar `RELAY_CONFIRM` antes de marcar conectividad o entrega exitosa.
- Crear rutas inversas solamente después de autenticar el `RELAY_REQ`.
- Aplicar deduplicación por identidad de origen, época y contador.
- Limitar solicitudes pendientes por origen para evitar agotar tablas y colas.
- Broadcast puede usarse para descubrimiento, pero nunca para confiar en una
  identidad o ejecutar una acción sin autenticación de aplicación.

## Configuración remota y acceso técnico

- `CONFIG` debe usar una clave administrativa separada.
- Incluir destinatario exacto, contador administrativo, expiración y máscara de
  campos autorizados.
- Cambios de clave, `networkId`, gateway o canal requieren una operación de
  reprovisión con confirmación local o credencial técnica fuerte.
- La pulsación oculta de tres segundos debe abrir como máximo el formulario;
  guardar parámetros sensibles requerirá PIN técnico robusto, token temporal o
  modo de mantenimiento físico controlado.
- Limitar intentos y aplicar espera creciente después de fallos.
- No mostrar claves existentes en pantalla.

## Registro, alertas y privacidad

- Contabilizar rechazos por tag inválido, replay, red incorrecta, tipo no
  autorizado, longitud inválida y rate limit.
- No imprimir payloads sensibles, claves, tags completos ni credenciales.
- Evitar responder a mensajes claramente inválidos para no facilitar sondeo ni
  amplificación.
- Generar alerta ante muchos rechazos de un mismo origen o cambios anómalos de
  ruta.
- Mantener logs con hora, tipo de evento, identidad lógica y resultado, sin
  datos del paciente.

## Rate limiting y disponibilidad

- Limitar frames inválidos antes de operaciones costosas cuando sea posible,
  sin omitir la autenticación de mensajes que puedan ser legítimos.
- Limitar `REGISTER`, `CONFIG`, `RELAY_REQ` y cambios de ruta por emisor.
- Mantener límites estrictos de longitud, TTL, colas y tablas.
- No reiniciar continuamente ante tráfico inválido o fallo de autenticación.
- Las llamadas locales deben conservar una ruta de recuperación definida si la
  radio está degradada, sin aceptar mensajes inseguros como fallback.

## Migración sin modo inseguro permanente

1. Implementar primero protocolo v2 en gateway con telemetría de compatibilidad.
2. Añadir soporte v2 en terminales, inicialmente en laboratorio aislado.
3. Aprovisionar claves únicas y `networkId` fuera del repositorio.
4. Probar directo, relay de un salto, multi-salto, reinicio y pérdida de energía.
5. Migrar todos los dispositivos de una instalación en una ventana controlada.
6. Desactivar protocolo v1 después de verificar el inventario completo.
7. No permitir downgrade automático de v2 a v1 en producción.
8. Documentar procedimiento de rollback de firmware que conserve claves y
   contadores, pero que no reactive frames sin autenticar.

Durante la transición, un equipo en modo compatibilidad debe indicar claramente
el estado inseguro en logs de administración. La compatibilidad debe tener fecha
de retiro y no quedar habilitada indefinidamente.

## Pruebas de aceptación

Las pruebas deben ejecutarse con equipos propios, identificadores ficticios y
gateway/base de datos de laboratorio. No realizar interferencia de radio.

| Caso | Resultado requerido |
|---|---|
| Frame válido y autorizado | Se procesa una sola vez |
| Tag incorrecto | Se rechaza sin alterar estado |
| Un byte del payload modificado | Se rechaza |
| MAC suplantada sin clave | Se rechaza |
| `deviceId` válido con clave incorrecta | Se rechaza |
| `networkId` diferente | Se rechaza |
| Contador repetido | No se vuelve a ejecutar |
| Contador antiguo tras reiniciar | Se rechaza |
| Tipo no autorizado para el emisor | Se rechaza |
| ACK o confirmación relay falsos | No cambian conectividad ni TX |
| CONFIG falsa o vencida | No cambia NVS ni estado |
| Heartbeat falso con métrica mejor | No altera selección de ruta |
| Frame truncado o sobredimensionado | Se rechaza sin crash |
| Muchos frames inválidos | Se limita el origen; el equipo sigue operativo |
| Clave revocada | Todos sus mensajes se rechazan |
| Relay legítimo de varios saltos | Conserva autenticación de extremo a extremo |

## Criterios de salida a producción

- Todos los tipos de frame están autenticados antes de procesarse.
- Gateway y terminal aplican antireplay persistente en ambas direcciones.
- No existen claves globales predeterminadas ni secretos dentro de Git.
- La revocación individual fue probada.
- Se completaron pruebas directas, relay y multi-salto con pérdida de paquetes.
- El protocolo v1 está deshabilitado o existe una fecha aprobada para retirarlo.
- Secure Boot, Flash Encryption y actualización firmada están habilitados y
  documentados para los equipos de producción.
- Existe un procedimiento de incidente: aislar, revocar, reprovisionar, auditar
  y restaurar servicio.

## Orden recomendado de implementación futura

1. Inventario de todos los frames y puntos de envío/recepción del terminal y
   gateway.
2. Definir protocolo v2 compartido, serialización y límites de tamaño.
3. Implementar almacén de claves y aprovisionamiento por dispositivo.
4. Implementar HMAC común y pruebas con vectores conocidos.
5. Incorporar contador de 64 bits, época y persistencia antireplay.
6. Proteger ACK, CONFIG y eventos de llamada directos.
7. Proteger heartbeat, relay por salto y extremo a extremo.
8. Añadir autorización, rate limiting, auditoría y revocación.
9. Activar protecciones de arranque, flash y actualización.
10. Ejecutar migración controlada y retirar v1.

## Decisiones que deben tomarse antes de programar

- Método físico y operativo de aprovisionamiento inicial.
- Lugar seguro donde el gateway almacenará claves.
- Uso de HMAC solamente o AEAD para determinados payloads.
- Política exacta de rotación y duración de claves.
- Tamaño de ventana antireplay y frecuencia de persistencia.
- Esquema de autenticación por salto para relay.
- Procedimiento de recuperación de un equipo que pierda NVS.
- Estrategia de actualización firmada y rollback.
- Responsable de aprobar altas, bajas y cambios administrativos.
