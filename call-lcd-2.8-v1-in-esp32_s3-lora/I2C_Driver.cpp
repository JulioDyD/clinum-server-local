/*
 * I2C_Driver.cpp
 *
 * Este archivo implementa funciones básicas para inicializar y comunicar dispositivos I2C
 * en el ESP32 usando la librería Wire. Permite leer y escribir registros de dispositivos I2C
 * como sensores, expansores de pines, pantallas, etc.
 *
 * Funciones:
 *   - I2C_Init: Inicializa el bus I2C con los pines y frecuencia definidos.
 *   - I2C_Read: Lee datos de un registro de un dispositivo I2C (dirección de registro de 8 bits).
 *   - I2C_Write: Escribe datos en un registro de un dispositivo I2C (dirección de registro de 8 bits).
 */
#include "I2C_Driver.h"                    

// Inicializa el bus I2C con los pines y frecuencia definidos en I2C_Driver.h
void I2C_Init(void) {
  Wire.begin( I2C_SDA_PIN, I2C_SCL_PIN, I2C_Frequency);                       
}
// Lee datos de un registro de un dispositivo I2C (registro de 8 bits)
// Driver_addr: dirección I2C del dispositivo
// Reg_addr: dirección del registro a leer
// Reg_data: puntero donde se almacenarán los datos leídos
// Length: cantidad de bytes a leer
bool I2C_Read(uint8_t Driver_addr, uint8_t Reg_addr, uint8_t *Reg_data, uint32_t Length)
{
  Wire.beginTransmission(Driver_addr);
  Wire.write(Reg_addr); 
  if ( Wire.endTransmission(true)){
    printf("The I2C transmission fails. - I2C Read\r\n");
    return false;
  }
  Wire.requestFrom(Driver_addr, Length);
  for (int i = 0; i < (int)Length; i++) {
    *Reg_data++ = Wire.read();
  }
  return true;
}
// Escribe datos en un registro de un dispositivo I2C (registro de 8 bits)
// Driver_addr: dirección I2C del dispositivo
// Reg_addr: dirección del registro a escribir
// Reg_data: puntero a los datos a escribir
// Length: cantidad de bytes a escribir
bool I2C_Write(uint8_t Driver_addr, uint8_t Reg_addr, const uint8_t *Reg_data, uint32_t Length)
{
  Wire.beginTransmission(Driver_addr);
  Wire.write(Reg_addr);       
  for (int i = 0; i < (int)Length; i++) {
    Wire.write(*Reg_data++);
  }
  if ( Wire.endTransmission(true))
  {
    printf("The I2C transmission fails. - I2C Write\r\n");
    return false;
  }
  return true;
}