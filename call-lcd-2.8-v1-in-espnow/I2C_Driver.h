/*
 * I2C_Driver.h
 *
 * Cabecera para funciones de comunicación I2C en ESP32 usando la librería Wire.
 * Define pines, frecuencia y prototipos para inicializar, leer y escribir en dispositivos I2C.
 *
 * Pines y frecuencia por defecto:
 *   - SCL: GPIO7
 *   - SDA: GPIO15
 *   - Frecuencia: 800kHz
 *
 * Funciones:
 *   - I2C_Init: Inicializa el bus I2C.
 *   - I2C_Read: Lee datos de un registro de un dispositivo I2C.
 *   - I2C_Write: Escribe datos en un registro de un dispositivo I2C.
 */
#pragma once
#include <Wire.h> 


#define I2C_SCL_PIN       7      // Pin SCL (reloj) del bus I2C
#define I2C_SDA_PIN       15     // Pin SDA (datos) del bus I2C
// GT911 opera típicamente a 400 kHz de forma estable
#define I2C_Frequency     400000 // Frecuencia del bus I2C en Hz (400kHz)

// Inicializa el bus I2C con los pines y frecuencia definidos arriba
void I2C_Init(void);

// Lee datos de un registro de un dispositivo I2C
// Driver_addr: dirección I2C del dispositivo
// Reg_addr: dirección del registro a leer
// Reg_data: puntero donde se almacenarán los datos leídos
// Length: cantidad de bytes a leer
bool I2C_Read(uint8_t Driver_addr, uint8_t Reg_addr, uint8_t *Reg_data, uint32_t Length);

// Escribe datos en un registro de un dispositivo I2C
// Driver_addr: dirección I2C del dispositivo
// Reg_addr: dirección del registro a escribir
// Reg_data: puntero a los datos a escribir
// Length: cantidad de bytes a escribir
bool I2C_Write(uint8_t Driver_addr, uint8_t Reg_addr, const uint8_t *Reg_data, uint32_t Length);