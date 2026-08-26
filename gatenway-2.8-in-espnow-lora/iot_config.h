#pragma once

// Serial bridge
#define SERIAL_BAUD_RATE 115200

// ESP-NOW
#define ESPNOW_CHANNEL 1              // Canal fijo (1, 6 o 11 recomendado para LR)
#define MAX_KNOWN_DEVICES 64

// Limite de peers ESP-NOW unicast del chip (hardware limit)
#define ESPNOW_MAX_UNICAST_PEERS 20

// Deduplicacion de frames (evita doble emision cuando relay + directo llegan al gateway)
#define ESPNOW_DEDUP_CACHE_SIZE 128   // Entradas en cache de deduplicacion
#define ESPNOW_DEDUP_TTL_MS     30000 // Tiempo que se considera duplicado (30s)

// Colas RX: eventos clinicos separados de heartbeats para que presencia no
// pueda ocupar los slots reservados a llamadas y registros.
#define ESPNOW_EVENT_QUEUE_SIZE  32
#define ESPNOW_HEARTBEAT_QUEUE_SIZE 16

// Optional debug
#define ENABLE_SERIAL_DEBUG true

// LoRa (REYAX RYLR998) — radio hibrida opcional (estrella LoRa + malla ESP-NOW)
#define LORA_ENABLED true
#define LORA_UART_BAUD 115200
#define LORA_RX_PIN 44
#define LORA_TX_PIN 43
#define LORA_FREQ_HZ 915000000UL
#define LORA_SF 9
#define LORA_BW 7
#define LORA_CR 1
#define LORA_PREAMBLE 12
#define LORA_CRC 1
#define LORA_TX_POWER_DBM 22
#define LORA_GATEWAY_ADDRESS 0x0001
