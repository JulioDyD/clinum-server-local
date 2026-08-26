/*
 * TCA9554PWR.h
 *
 * Cabecera para controlar el expansor de pines I2C TCA9554PWR desde el ESP32.
 * Permite agregar pines digitales (entradas/salidas) usando I2C.
 *
 * Define macros de registros, pines y prototipos de funciones para:
 *   - Leer/escribir registros del TCA9554PWR
 *   - Configurar pines como entrada/salida
 *   - Leer y escribir el estado de los pines
 *   - Inicializar el chip con un estado inicial
 */
#pragma once

#include <stdio.h>
#include "I2C_Driver.h"

/****************************************************** The macro defines the TCA9554PWR information ******************************************************/ 

#define TCA9554_ADDRESS         0x20    // Dirección I2C del TCA9554PWR

#define TCA9554_INPUT_REG       0x00    // Registro de entrada (leer estado de pines)
#define TCA9554_OUTPUT_REG      0x01    // Registro de salida (escribir estado de pines)
#define TCA9554_Polarity_REG    0x02    // Registro de inversión de polaridad
#define TCA9554_CONFIG_REG      0x03    // Registro de configuración (entrada/salida)


#define Low   0
#define High  1
#define EXIO_PIN1   1  // Pines virtuales del expansor (1-8)
#define EXIO_PIN2   2
#define EXIO_PIN3   3
#define EXIO_PIN4   4
#define EXIO_PIN5   5
#define EXIO_PIN6   6
#define EXIO_PIN7   7
#define EXIO_PIN8   8


// Lee el valor de un registro del TCA9554PWR
uint8_t I2C_Read_EXIO(uint8_t REG);
// Escribe un valor en un registro del TCA9554PWR
uint8_t I2C_Write_EXIO(uint8_t REG,uint8_t Data);
// Configura un pin como entrada (1) o salida (0)
void Mode_EXIO(uint8_t Pin,uint8_t State);
// Configura los 7 pines con el estado PinState (bit=1 entrada, bit=0 salida)
void Mode_EXIOS(uint8_t PinState);
// Lee el estado lógico de un pin
uint8_t Read_EXIO(uint8_t Pin);
// Lee el estado lógico de todos los pines (por defecto entradas)
uint8_t Read_EXIOS(uint8_t REG);
// Cambia el estado lógico (alto/bajo) de un pin sin afectar los demás
void Set_EXIO(uint8_t Pin,uint8_t State);
// Cambia el estado lógico de los 7 pines según PinState
void Set_EXIOS(uint8_t PinState);
// Invierte el estado lógico de un pin
void Set_Toggle(uint8_t Pin);
// Inicializa el TCA9554PWR configurando los pines según PinState (bit=1 entrada, bit=0 salida)
void TCA9554PWR_Init(uint8_t PinState = 0x00);
