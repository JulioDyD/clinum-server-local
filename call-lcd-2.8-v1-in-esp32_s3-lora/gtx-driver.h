/*
 * LVGL_Driver.h
 *
 * Cabecera para la integración de LVGL con el hardware (pantalla y touch) en ESP32.
 * Define macros de resolución, buffer y prototipos para inicializar y operar LVGL.
 *
 * Funciones principales:
 *   - Lvgl_Init: Inicializa LVGL, el buffer y los drivers de pantalla/touch.
 *   - Lvgl_Loop: Ejecuta el handler principal de LVGL (debe llamarse en loop()).
 *   - Lvgl_Display_LCD: Callback para que LVGL dibuje en la pantalla física.
 *   - Lvgl_Touchpad_Read: Callback para que LVGL lea el touch.
 *   - Lvgl_print: (opcional) para debug.
 */
#pragma once

#include <lvgl.h>
#include "lv_conf.h"
#include <esp_heap_caps.h>
#include "Display_ST7701.h"
#include "Touch_GT911.h"

#define LVGL_WIDTH     ESP_PANEL_LCD_WIDTH   // Ancho de la pantalla para LVGL
#define LVGL_HEIGHT    ESP_PANEL_LCD_HEIGHT  // Alto de la pantalla para LVGL
#define LVGL_BUF_LEN  (LVGL_WIDTH * LVGL_HEIGHT * sizeof(lv_color_t)) // Tamaño del buffer de LVGL

#define EXAMPLE_LVGL_TICK_PERIOD_MS  2 // Periodo del tick de LVGL en milisegundos (si se usa tick manual)


extern lv_disp_drv_t disp_drv;

// Imprime mensajes de debug de LVGL (opcional)
void Lvgl_print(const char * buf);
// Callback: LVGL dibuja en la pantalla física
void Lvgl_Display_LCD( lv_disp_drv_t *disp_drv, const lv_area_t *area, lv_color_t *color_p );
// Callback: LVGL lee el touch
void Lvgl_Touchpad_Read( lv_indev_drv_t * indev_drv, lv_indev_data_t * data );
// (Opcional) Incrementa el tick de LVGL si se usa tick manual
void example_increase_lvgl_tick(void *arg);

// Inicializa LVGL, buffer y drivers
void Lvgl_Init(void);
// Ejecuta el handler principal de LVGL (llamar en loop())
void Lvgl_Loop(void);
