#pragma once

// ========================================
// VERSIÓN DEL FIRMWARE
// ========================================
#define FIRMWARE_VERSION            "4.8"               // Versión del firmware del terminal

/**
 * @file iot_config.h
 * @brief Configuración de Conectividad IoT

 * @date 18 de septiembre de 2025
 *
 * Parámetros de configuración para conectividad WiFi y Firebase
 * IMPORTANTE: Mantener las credenciales seguras en entornos de producción
 */

// ========================================
// CONFIGURACIÓN DEL SISTEMA DE LLAMADAS
// ========================================
#define CALL_TYPE_NORMAL            "normal"             // Tipo de llamada normal
#define CALL_TYPE_EMERGENCY         "emergency"          // Tipo de llamada de emergencia
#define EMERGENCY_LONG_PRESS_TIME_MS 2000                // Tiempo de pulsación prolongada para activar emergencia (2 segundos)

// ========================================
// CONFIGURACIÓN DE PINES DE HARDWARE
// ========================================
#define BOTON_AEREO_PIN             0                  // Pin GPIO para el botón físico aéreo
#define BUZZER_EXIO_PIN             8                   // Pin del expansor TCA9554 para el buzzer (EXIO8)
#define BOTON_AEREO_DEBOUNCE_DELAY  50                  // Retardo de debounce del botón aéreo (50ms)

// ========================================
// CONFIGURACIÓN DE LEDS
// ========================================
#define LED_BLINK_INTERVAL_MS       500                  // Intervalo de parpadeo de LEDs (500ms)
#define LED_BLINK_EMERGENCY_MS      200                  // Parpadeo rojo en emergencia (200ms)

// ========================================
// CONFIGURACIÓN DE TIEMPOS Y DURACIONES
// ========================================
#define CANCEL_LED_DURATION_MS      1000                 // Duración del LED de cancelación (1 segundo)
#define SERIAL_BAUD_RATE            115200               // Velocidad de comunicación serial
#define ONE_HOUR_SECONDS            3600                 // Una hora en segundos

// ========================================
// CONFIGURACIÓN DE TIEMPOS DE UI
// ========================================
#define WELCOME_DURATION_MS         4000                 // Duración del logo y llenado de su barra (4 segundos)
#define DOUBLE_TOUCH_TIMEOUT        2000                 // Timeout para completar doble toque (2 segundos)
#define PATIENT_TOUCH_INTERVAL      400                  // Máximo intervalo entre toques del paciente (400ms)

// ========================================
// CONFIGURACIÓN DE INTERVALOS DE ACTUALIZACIÓN
// ========================================
#define TIME_UPDATE_INTERVAL        1000                 // Intervalo de actualización de hora (1 segundo)
#define NETWORK_UPDATE_INTERVAL     5000                 // Intervalo de actualización de red (5 segundos)

// ========================================
// CONFIGURACIÓN DE ANIMACIONES DE PANTALLA
// ========================================
#define SCREEN_CHANGE_ANIMATION_MS  300                  // Duración de animación de cambio de pantalla (300ms)
#define SCREEN3_AUTO_RETURN_MS      60000                // Auto-retorno desde Screen3 (1 minuto)
#define SCREEN4_AUTO_RETURN_MS      60000                // Auto-retorno desde Screen4 (1 minuto)
#define SCREEN5_AUTO_RETURN_MS      60000                // Auto-retorno desde Screen5 (1 minuto)
#define SCREEN6_AUTO_RETURN_MS      60000                // Auto-retorno desde Screen6 (1 minuto)


// ========================================
// CONFIGURACIÓN DE BUZZER
// ========================================
#define EMERGENCY_BEEP_INTERVAL     15000                // Intervalo de pitido de emergencia (15 segundos)
#define BUZZER_DELAY_150_MS         150                  // Delay de 150ms para buzzer (efecto visual emergencia)

// ========================================
// CONFIGURACIÓN DE AUDIO
// ========================================
#define ENABLE_CONNECTION_AUDIO_ALERT true               // Habilitar/deshabilitar alerta de audio cuando se pierde la conexión

// ========================================
// CONFIGURACIÓN DE DEBUG Y LOGGING
// ========================================
#define ENABLE_SERIAL_DEBUG         true                 // Habilitar/deshabilitar mensajes de debug en monitor serial

// ========================================
// CONFIGURACIÓN DE CONTROL DE BRILLO LCD
// ========================================
#define DEFAULT_BRIGHTNESS_LEVEL    80                   // Nivel de brillo por defecto (80%)
#define MIN_BRIGHTNESS_LEVEL        10                   // Nivel mínimo de brillo para evitar pantalla apagada
#define MAX_BRIGHTNESS_LEVEL        100                  // Nivel máximo de brillo

// ========================================
// CONFIGURACION ESP-NOW (LOCAL BRIDGE)
// ========================================
#define ESPNOW_GATEWAY_MAC           "CC:BA:97:11:5E:50" // MAC del gateway (ajustar en sitio)
#define ESPNOW_CHANNEL               1                    // Canal fijo (1, 6 o 11 recomendado para LR)
#define ESPNOW_ACK_TIMEOUT_MS        2500                 // Timeout de ACK final desde servidor local/Windows
#define HEARTBEAT_INTERVAL_MS        30000                // Intervalo de heartbeat al gateway (30 segundos)
#define ESPNOW_DEDUP_CACHE_SIZE      256                  // Entradas en caché de dedup (aumentado de 128)
#define ESPNOW_DEDUP_TTL_MS          300000                 // Tiempo que se considera duplicado (5 min)

// ========================================
// CONFIGURACION TX QUEUE NO BLOQUEANTE
// ========================================
#define ESPNOW_TX_QUEUE_SIZE         4                    // Slots en la cola de transmision (llamada+insist+fin+extra)
#define ESPNOW_MAX_RETRIES           2                    // Reintentos directos al gateway antes de intentar relay

// ========================================
// CONFIGURACION RELAY MESH 1-HOP
// ========================================
// Variante LoRa: el terminal llega al gateway por radio LoRa (1 salto), no
// participa en la malla ESP-NOW, asi que el relay mesh se desactiva.
#define ESPNOW_RELAY_ENABLED         0                    // 1=habilitar relay mesh, 0=deshabilitar
#define ESPNOW_RELAY_PEER_MAX        6                    // Maximo de terminales vecinos como candidatos relay
#define ESPNOW_RELAY_CONFIRM_TIMEOUT_MS 4000              // Timeout esperando ACK final a traves de relay (ms)
#define ESPNOW_PRESENCE_INTERVAL_MS  5000                 // Intervalo de broadcast de presencia (5s — rapido para descubrimiento en boot)
#define ESPNOW_RELAY_STALE_MS        120000               // Tiempo sin ver un peer para marcarlo inactivo (2 min)
#define ESPNOW_RELAY_TTL             4                    // Saltos maximos del relay (4 hops = hasta 4 nodos intermedios)

// ---- Calidad de enlace para seleccion de relay (evita elegir relays lejanos con senal debil) ----
#define RELAY_RSSI_MIN_THRESHOLD     -78                  // dBm. Por debajo de esto, el peer NO es candidato valido
#define RELAY_RSSI_HYSTERESIS_DB     6                    // dB de margen minimo para cambiar de relay ya establecido
#define RELAY_METRIC_HYSTERESIS      1                    // saltos de margen minimo para preferir un metric menor
#define RELAY_RSSI_SMOOTH_ALPHA      0.3f                 // peso de la lectura nueva en el promedio movil (0-1)
#define RELAY_BLACKLIST_MS           4000                 // ms que un peer relay queda excluido tras un envio con status FAIL (802.11 sin ACK)

// ========================================
// CONFIGURACION REGISTRO / RECONEXION
// ========================================
#define REGISTER_BOOT_RETRIES        20      // Intentos de registro al arrancar antes de reiniciar
#define REGISTER_BOOT_RETRY_DELAY_MS 2000    // Pausa entre intentos de registro en boot (ms)
#define GATEWAY_LOST_TIMEOUT_MS      70000   // Sin ACK del gateway por este tiempo → reconexion (ms)
#define BOOT_NEIGHBOR_LISTEN_MS      (ESPNOW_PRESENCE_INTERVAL_MS + 500) // Ventana de escucha de vecinos antes del primer intento de registro

// ========================================
// CONFIGURACION LORA (REYAX RYLR998) — zona critica
// ========================================
// Transporte primario: el terminal usa LoRa directo al gateway en vez de ESP-NOW.
// Pines del header UART de la Waveshare ESP32-S3-Touch-LCD-2.8B.
#define USE_LORA_TRANSPORT 1
#define LORA_UART_BAUD 115200
#define LORA_RX_PIN 44   // header RXD <- modulo TXD (RX del ESP32)
#define LORA_TX_PIN 43   // header TXD -> modulo RXD (TX del ESP32)
#define LORA_FREQ_HZ 915000000UL
#define LORA_SF 9
#define LORA_BW 7
#define LORA_CR 1
#define LORA_PREAMBLE 12
#define LORA_CRC 1
#define LORA_TX_POWER_DBM 22
#define LORA_CALLER_ADDRESS 0x0004
#define LORA_GATEWAY_ADDRESS 0x0001
