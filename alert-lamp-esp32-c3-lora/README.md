# Lámpara sonora ESP-NOW (ESP32-C3)

Firmware para una lámpara de llamados con anillo WS2812 de 24 LED, buzzer pasivo y función de relay para llamadores.

## Dependencia Arduino

Instalar `Adafruit NeoPixel` desde el Library Manager. Seleccionar una placa ESP32-C3 y revisar los pines de `iot_config.h` antes de compilar.

## Protocolo

La lámpara se registra con `LAMP_REGISTER`, publica `LAMP_HEARTBEAT`, solicita el snapshot autoritativo al iniciar y aplica únicamente revisiones nuevas de `LAMP_STATE`. Los presets aceptan valores `0..19` para color, animación y sonido. El audio y brillo se aplican por lámpara.

La salida queda apagada hasta recibir el primer snapshot del servidor. El firmware también acepta `RELAY_REQ` de llamadores y reenvía ACK/configuración por la ruta inversa conocida.
