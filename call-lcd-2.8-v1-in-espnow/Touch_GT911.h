/*
 * Touch_GT911.h
 *
 * Definiciones y prototipos para el controlador de touch GT911 en ESP32-S3.
 * Incluye pines, direcciones, registros y funciones para inicializar y leer el panel táctil capacitivo.
 *
 * Funciones principales:
 *   - Touch_Init: Inicializa el touch y configura la interrupción.
 *   - GT911_Touch_Reset: Realiza un reset físico al touch.
 *   - GT911_Read_cfg: Lee la configuración y resolución del touch.
 *   - Touch_Read_Data: Lee los datos de los puntos de contacto.
 *   - Touch_Get_XY: Obtiene las coordenadas y fuerza de los puntos tocados.
 *   - Touch_GT911_ISR: Manejador de interrupción para eventos de touch.
 */
#pragma once

#include "Arduino.h"
#include "I2C_Driver.h"
#include "TCA9554PWR.h"
#include "Display_ST7701.h"  


// Dirección I2C y pin de interrupción del touch GT911
#define GT911_ADDR          0x5D      // Dirección I2C del GT911
#define GT911_INT_PIN       16        // Pin de interrupción

// Opciones para espejar ejes (si la orientación del touch lo requiere)
#define Mirror_X       0              // 1: invierte eje X
#define Mirror_Y       0              // 1: invierte eje Y

// Dimensiones del área táctil (deben coincidir con la pantalla)
#define Touch_WIDTH     ESP_PANEL_LCD_WIDTH
#define Touch_HEIGHT    ESP_PANEL_LCD_HEIGHT

// Máximo de puntos multitouch soportados
#define GT911_LCD_TOUCH_MAX_POINTS   (5)

// Direcciones de registros internos del GT911
#define ESP_LCD_TOUCH_GT911_PRODUCT_ID_REG    (0x8140) // ID del producto
#define ESP_LCD_TOUCH_GT911_Resolution_REG    (0x8146) // Resolución X/Y
#define ESP_LCD_TOUCH_GT911_READ_DATA_REG     (0x814E) // Datos de touch



// Variable global para indicar si ocurrió una interrupción de touch
extern uint8_t Touch_interrupts;


// Estructura para almacenar los datos de los puntos de contacto
struct GT911_Touch{
  uint8_t points;    // Número de puntos tocados
  struct {
    uint16_t x;        // Coordenada X
    uint16_t y;        // Coordenada Y
    uint16_t strength; // Fuerza del toque
  }coords[GT911_LCD_TOUCH_MAX_POINTS];
};



// Prototipos de funciones principales
uint8_t Touch_Init(); // Inicializa el touch y la interrupción
void Touch_Loop(void); // Llama a la función de lectura si hay interrupción
uint8_t GT911_Touch_Reset(void); // Realiza un reset físico al touch
void GT911_Read_cfg(void); // Lee la configuración y resolución
uint8_t Touch_Read_Data(void); // Lee los datos de los puntos de contacto
uint8_t Touch_Get_XY(uint16_t *x, uint16_t *y, uint16_t *strength, uint8_t *point_num, uint8_t max_point_num); // Obtiene coordenadas y fuerza
void example_touchpad_read(void); // Ejemplo de lectura (debug)
void IRAM_ATTR Touch_GT911_ISR(void); // Manejador de interrupción
