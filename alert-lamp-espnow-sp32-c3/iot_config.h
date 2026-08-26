#pragma once

#define DEVICE_TYPE "alert_lamp_espnow_c3"
#define SERIAL_BAUD_RATE 115200

// Adjust these three pins to the final ESP32-C3 board wiring.
#define WS2812_PIN 8
#define WS2812_LED_COUNT 24
#define BUZZER_PIN 10
// Portadora PWM inaudible (buzzer activo) usada solo para modular el volumen; no es un tono.
#define BUZZER_PWM_FREQ_HZ 20000
#define BUZZER_PWM_RES_BITS 8

#define ESPNOW_GATEWAY_MAC "CC:BA:97:11:5E:50"
#define ESPNOW_CHANNEL 1
#define ESPNOW_REGISTER_INTERVAL_MS 5000
#define ESPNOW_HEARTBEAT_INTERVAL_MS 15000
#define ESPNOW_SNAPSHOT_RETRY_MS 2000
#define ESPNOW_GATEWAY_STALE_MS 70000
#define ESPNOW_ROUTE_STALE_MS 120000
#define ESPNOW_RX_QUEUE_SIZE 16
#define ESPNOW_REVERSE_ROUTE_SIZE 12
#define ESPNOW_DEDUP_SIZE 32
#define ENABLE_SERIAL_DEBUG 1
