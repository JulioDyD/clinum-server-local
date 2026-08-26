/*
 * Display_ST7701.h
 *
 * Definiciones y configuraciones para el controlador de la pantalla LCD ST7701 en ESP32-S3.
 * Incluye pines, parámetros de resolución, configuración RGB, y prototipos de funciones para inicialización y control.
 *
 * Funciones principales:
 *   - ST7701_Init: Inicializa el bus SPI y la pantalla.
 *   - LCD_Init: Inicializa display, touch y realiza reset.
 *   - LCD_addWindow: Dibuja una región rectangular en la pantalla.
 *   - Backlight_Init / Set_Backlight: Inicializan y ajustan el brillo del backlight.
 */
#pragma once
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_rgb.h"

#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "freertos/task.h"

#include "TCA9554PWR.h"
#include "gtx-driver.h"
#include "Touch_GT911.h"


// Pines de conexión para el display y backlight
#define LCD_CLK_PIN   2              // Pin de reloj SPI
#define LCD_MOSI_PIN  1              // Pin MOSI SPI
#define LCD_Backlight_PIN   6        // Pin PWM para backlight

// Parámetros PWM para el control del backlight
#define PWM_Channel     1       // Canal PWM
#define Frequency       20000   // Frecuencia PWM (Hz)
#define Resolution      10      // Resolución PWM (bits)
#define Dutyfactor      500     // Ciclo de trabajo inicial
#define Backlight_MAX   100     // Valor máximo de brillo



// Parámetros de resolución y sincronización para el panel RGB
// Resolución FÍSICA del panel: 480×640 (portrait nativo según Waveshare wiki)
#define ESP_PANEL_LCD_WIDTH                       (480)   // Ancho físico de la pantalla
#define ESP_PANEL_LCD_HEIGHT                      (640)   // Alto físico de la pantalla
#define ESP_PANEL_LCD_RGB_TIMING_FREQ_HZ          (30 * 1000 * 1000) // Frecuencia de pixel clock
#define ESP_PANEL_LCD_RGB_TIMING_HPW              (10)    // Ancho pulso HSYNC
#define ESP_PANEL_LCD_RGB_TIMING_HBP              (70)    // Back porch HSYNC
#define ESP_PANEL_LCD_RGB_TIMING_HFP              (60)    // Front porch HSYNC
#define ESP_PANEL_LCD_RGB_TIMING_VPW              (10)    // Ancho pulso VSYNC
#define ESP_PANEL_LCD_RGB_TIMING_VBP              (20)    // Back porch VSYNC
#define ESP_PANEL_LCD_RGB_TIMING_VFP              (20)    // Front porch VSYNC
#define ESP_PANEL_LCD_RGB_PCLK_ACTIVE_NEG         (0)     // 0: flanco de subida, 1: bajada
#define ESP_PANEL_LCD_RGB_DATA_WIDTH              (16)    // Bits de datos RGB
#define ESP_PANEL_LCD_RGB_PIXEL_BITS              (16)    // Bits por pixel (24 o 16)
#define ESP_PANEL_LCD_RGB_FRAME_BUF_NUM           (1)     // Número de frame buffers
#define ESP_PANEL_LCD_RGB_BOUNCE_BUF_SIZE         (10 * ESP_PANEL_LCD_HEIGHT) // Tamaño del bounce buffer
// El bounce buffer ayuda a evitar el "screen drift". Para activarlo, usar un valor distinto de cero.



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Configuración de pines para la interfaz RGB. Actualizar según el hardware utilizado.
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


#define ESP_PANEL_LCD_PIN_NUM_RGB_HSYNC           (38) // Pin HSYNC
#define ESP_PANEL_LCD_PIN_NUM_RGB_VSYNC           (39) // Pin VSYNC
#define ESP_PANEL_LCD_PIN_NUM_RGB_DE              (40) // Pin Data Enable
#define ESP_PANEL_LCD_PIN_NUM_RGB_PCLK            (41) // Pin Pixel Clock
#define ESP_PANEL_LCD_PIN_NUM_RGB_DISP            (-1) // Pin Display Enable (si aplica)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA0           (5)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA1           (45)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA2           (48)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA3           (47)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA4           (21)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA5           (14)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA6           (13)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA7           (12)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA8           (11)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA9           (10)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA10          (9)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA11          (46)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA12          (3)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA13          (8)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA14          (18)
#define ESP_PANEL_LCD_PIN_NUM_RGB_DATA15          (17)


#define ESP_PANEL_LCD_BK_LIGHT_ON_LEVEL           (1) // Nivel lógico para encender el backlight
#define ESP_PANEL_LCD_BK_LIGHT_OFF_LEVEL !ESP_PANEL_LCD_BK_LIGHT_ON_LEVEL // Nivel lógico para apagar el backlight


bool example_on_vsync_event(esp_lcd_panel_handle_t panel, const esp_lcd_rgb_panel_event_data_t *event_data, void *user_data);

// Variables globales para el panel y el brillo
extern esp_lcd_panel_handle_t panel_handle;  // Manejador del panel LCD
extern uint8_t LCD_Backlight;                // Valor actual de brillo

// Prototipos de funciones principales
bool example_on_vsync_event(esp_lcd_panel_handle_t panel, const esp_lcd_rgb_panel_event_data_t *event_data, void *user_data); // Callback de vsync (opcional)
void ST7701_Init();           // Inicializa el bus SPI y la pantalla
void LCD_Init();              // Inicializa display, touch y realiza reset
void LCD_addWindow(uint16_t Xstart, uint16_t Ystart, uint16_t Xend, uint16_t Yend,uint8_t* color); // Dibuja una región

// Control de backlight
void Backlight_Init();        // Inicializa el PWM del backlight
void Set_Backlight(uint8_t Light); // Ajusta el brillo (0-100)