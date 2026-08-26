#pragma once

#define DEVICE_TYPE "alert_lamp_lora_c3"
#define SERIAL_BAUD_RATE 115200

// LoRa (REYAX RYLR998) — transporte opcional para zonas criticas
#define USE_LORA_TRANSPORT 1
#define LORA_UART_BAUD 115200
#define LORA_RX_PIN 20   // XIAO C3: D7 = RX (UART0)
#define LORA_TX_PIN 21   // XIAO C3: D6 = TX (UART0)
#define LORA_FREQ_HZ 915000000UL
#define LORA_SF 9
#define LORA_BW 7
#define LORA_CR 1
#define LORA_PREAMBLE 12
#define LORA_CRC 1
#define LORA_TX_POWER_DBM 22
#define LORA_LAMP_ADDRESS 0x0020
#define LORA_GATEWAY_ADDRESS 0x0001

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
#define ESPNOW_DEDUP_SIZE 64
#define ENABLE_SERIAL_DEBUG 1
