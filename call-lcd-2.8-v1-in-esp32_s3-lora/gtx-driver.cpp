/*
 * LVGL_Driver.cpp
 *
 * Implementación de la integración de LVGL con el hardware (pantalla y touch) en ESP32.
 * Aquí se inicializa LVGL, se configuran los buffers, y se enlazan los drivers de pantalla y touch.
 *
 * Funciones principales:
 *   - Lvgl_Init: Inicializa LVGL, el buffer y los drivers de pantalla/touch.
 *   - Lvgl_Loop: Ejecuta el handler principal de LVGL (debe llamarse en loop()).
 *   - Lvgl_Display_LCD: Callback para que LVGL dibuje en la pantalla física.
 *   - Lvgl_Touchpad_Read: Callback para que LVGL lea el touch.
 *   - Lvgl_print: (opcional) para debug.
 */
#include "gtx-driver.h"

lv_disp_drv_t disp_drv;

static lv_disp_draw_buf_t draw_buf;
void* buf1 = NULL;
void* buf2 = NULL;
// static lv_color_t buf1[ LVGL_BUF_LEN ];
// static lv_color_t buf2[ LVGL_BUF_LEN ];
// static lv_color_t* buf1 = (lv_color_t*) heap_caps_malloc(LVGL_BUF_LEN, MALLOC_CAP_SPIRAM);
// static lv_color_t* buf2 = (lv_color_t*) heap_caps_malloc(LVGL_BUF_LEN, MALLOC_CAP_SPIRAM);
    


// Imprime mensajes de debug de LVGL (opcional)
void Lvgl_print(const char * buf)
{
  // Serial.printf(buf);
  // Serial.flush();
}

// Callback: LVGL dibuja en la pantalla física
void Lvgl_Display_LCD( lv_disp_drv_t *disp_drv, const lv_area_t *area, lv_color_t *color_p )
{
  LCD_addWindow(area->x1, area->y1, area->x2, area->y2, ( uint8_t *)&color_p->full);
  lv_disp_flush_ready( disp_drv );
}
// Callback: LVGL lee el touch
void Lvgl_Touchpad_Read( lv_indev_drv_t * indev_drv, lv_indev_data_t * data )
{
  uint16_t touchpad_x[GT911_LCD_TOUCH_MAX_POINTS] = {0};
  uint16_t touchpad_y[GT911_LCD_TOUCH_MAX_POINTS] = {0};
  uint16_t strength[GT911_LCD_TOUCH_MAX_POINTS]   = {0};
  uint8_t touchpad_cnt = 0;
  Touch_Read_Data();
  uint8_t touchpad_pressed = Touch_Get_XY(touchpad_x, touchpad_y, strength, &touchpad_cnt, GT911_LCD_TOUCH_MAX_POINTS);
  if (touchpad_pressed && touchpad_cnt > 0) {
    // IMPORTANTE: Cuando sw_rotate está activo, LVGL hace la rotación automáticamente
    // Solo debemos reportar las coordenadas en el espacio FÍSICO del panel (480×640)
    // LVGL las transformará según rotated=LV_DISP_ROT_90
    data->point.x = touchpad_x[0];    // Coordenada X física (0-479)
    data->point.y = touchpad_y[0];    // Coordenada Y física (0-639)
    data->state = LV_INDEV_STATE_PR;
    //printf("Touch RAW: X=%u Y=%u\r\n", touchpad_x[0], touchpad_y[0]);
  } else {
    data->state = LV_INDEV_STATE_REL;
  }
}

// Inicializa LVGL, buffer y drivers de pantalla/touch
void Lvgl_Init(void)
{
  lv_init();
  // esp_lcd_rgb_panel_get_frame_buffer(panel_handle, 2, &buf1, &buf2);                                          
  
  buf1 = (lv_color_t*) heap_caps_malloc(LVGL_BUF_LEN, MALLOC_CAP_SPIRAM);
  buf2 = (lv_color_t*) heap_caps_malloc(LVGL_BUF_LEN, MALLOC_CAP_SPIRAM);
  lv_disp_draw_buf_init( &draw_buf, buf1, buf2, LVGL_WIDTH * LVGL_HEIGHT);                    

  /* Inicializa el driver de display */
  lv_disp_drv_init( &disp_drv );
  /* Configurar con resolución FÍSICA: 480×640 */
  disp_drv.hor_res = LVGL_WIDTH;   // 480 físico
  disp_drv.ver_res = LVGL_HEIGHT;  // 640 físico
  disp_drv.flush_cb = Lvgl_Display_LCD;
  // No forzar refresco completo: permitir refresco parcial por defecto como en el demo estable
  // disp_drv.full_refresh = 0; // (opcional) por defecto LVGL usa parcial
  
  /* IMPORTANTE: Rotación software de LVGL para landscape (90°) */
  // Vertical puerto usb a la parte superior
  disp_drv.sw_rotate = 1;                  // Habilitar rotación software
  disp_drv.rotated = LV_DISP_ROT_180;       // Rotar 90° (480×640 → 640×480)
  
  disp_drv.draw_buf = &draw_buf;
  disp_drv.user_data = panel_handle;
  lv_disp_drv_register( &disp_drv );

  /* Inicializa el driver de touch */
  static lv_indev_drv_t indev_drv;
  lv_indev_drv_init( &indev_drv );
  indev_drv.type = LV_INDEV_TYPE_POINTER;
  indev_drv.read_cb = Lvgl_Touchpad_Read;
  lv_indev_drv_register( &indev_drv );

}
// Ejecuta el handler principal de LVGL (llamar en loop())
void Lvgl_Loop(void)
{
  lv_timer_handler(); /* Deja que la GUI haga su trabajo */
  // delay( 5 );
}
