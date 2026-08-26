/*
 * TCA9554PWR.cpp
 *
 * Implementa funciones para controlar el expansor de pines I2C TCA9554PWR desde el ESP32.
 * Permite configurar pines como entrada/salida, leer y escribir su estado, e inicializar el chip.
 *
 * Funciones principales:
 *   - I2C_Read_EXIO / I2C_Write_EXIO: Leer/escribir registros del TCA9554PWR.
 *   - Mode_EXIO / Mode_EXIOS: Configurar pines como entrada o salida.
 *   - Read_EXIO / Read_EXIOS: Leer el estado de uno o todos los pines.
 *   - Set_EXIO / Set_EXIOS: Cambiar el estado de uno o todos los pines.
 *   - Set_Toggle: Invertir el estado de un pin.
 *   - TCA9554PWR_Init: Inicializar el expansor con un estado inicial.
 */
#include "TCA9554PWR.h"

/*****************************************************  Operation register REG   ****************************************************/   
// Lee el valor de un registro del TCA9554PWR
uint8_t I2C_Read_EXIO(uint8_t REG)
{
  Wire.beginTransmission(TCA9554_ADDRESS);                
  Wire.write(REG);                                        
  uint8_t result = Wire.endTransmission();               
  if (result != 0) {                                     
    printf("Data Transfer Failure !!!\r\n");
  }
  Wire.requestFrom(TCA9554_ADDRESS, 1);                   
  uint8_t bitsStatus = Wire.read();                        
  return bitsStatus;                                     
}
// Escribe un valor en un registro del TCA9554PWR
uint8_t I2C_Write_EXIO(uint8_t REG,uint8_t Data)
{
  Wire.beginTransmission(TCA9554_ADDRESS);                
  Wire.write(REG);                                        
  Wire.write(Data);                                       
  uint8_t result = Wire.endTransmission();                  
  if (result != 0) {    
    printf("Data write failure!!!\r\n");
    return -1;
  }
  return 0;                                             
}
/********************************************************** Set EXIO mode **********************************************************/       
// Configura un pin del TCA9554PWR como entrada (1) o salida (0)
void Mode_EXIO(uint8_t Pin,uint8_t State)
{
  uint8_t bitsStatus = I2C_Read_EXIO(TCA9554_CONFIG_REG);      
  uint8_t Data = (0x01 << (Pin-1)) | bitsStatus;   
  uint8_t result = I2C_Write_EXIO(TCA9554_CONFIG_REG,Data); 
  if (result != 0) { 
    printf("I/O Configuration Failure !!!\r\n");
  }
}
// Configura los 7 pines del TCA9554PWR con el estado PinState (bit=1 entrada, bit=0 salida)
void Mode_EXIOS(uint8_t PinState)
{
  uint8_t result = I2C_Write_EXIO(TCA9554_CONFIG_REG,PinState);  
  if (result != 0) {   
    printf("I/O Configuration Failure !!!\r\n");
  }
}
/********************************************************** Read EXIO status **********************************************************/       
// Lee el estado lógico de un pin del TCA9554PWR
uint8_t Read_EXIO(uint8_t Pin)
{
  uint8_t inputBits = I2C_Read_EXIO(TCA9554_INPUT_REG);          
  uint8_t bitStatus = (inputBits >> (Pin-1)) & 0x01; 
  return bitStatus;                                  
}
// Lee el estado lógico de todos los pines del TCA9554PWR (por defecto entradas)
uint8_t Read_EXIOS(uint8_t REG = TCA9554_INPUT_REG)
{
  uint8_t inputBits = I2C_Read_EXIO(REG);                     
  return inputBits;     
}

/********************************************************** Set the EXIO output status **********************************************************/  
// Cambia el estado lógico (alto/bajo) de un pin del TCA9554PWR sin afectar los demás
void Set_EXIO(uint8_t Pin,uint8_t State)
{
  uint8_t Data;
  if(State < 2 && Pin < 9 && Pin > 0){  
    uint8_t bitsStatus = Read_EXIOS(TCA9554_OUTPUT_REG);
    if(State == 1)                                     
      Data = (0x01 << (Pin-1)) | bitsStatus; 
    else if(State == 0)                  
      Data = (~(0x01 << (Pin-1))) & bitsStatus;      
    uint8_t result = I2C_Write_EXIO(TCA9554_OUTPUT_REG,Data);  
    if (result != 0) {                         
      printf("Failed to set GPIO!!!\r\n");
    }
  }
  else                                           
    printf("Parameter error, please enter the correct parameter!\r\n");
}
// Cambia el estado lógico de los 7 pines del TCA9554PWR según el valor de PinState
void Set_EXIOS(uint8_t PinState)
{
  uint8_t result = I2C_Write_EXIO(TCA9554_OUTPUT_REG,PinState); 
  if (result != 0) {                  
    printf("Failed to set GPIO!!!\r\n");
  }
}
/********************************************************** Flip EXIO state **********************************************************/  
// Invierte el estado lógico de un pin del TCA9554PWR
void Set_Toggle(uint8_t Pin)
{
    uint8_t bitsStatus = Read_EXIO(Pin);                 
    Set_EXIO(Pin,(bool)!bitsStatus); 
}
/********************************************************* TCA9554PWR Initializes the device ***********************************************************/  
// Inicializa el TCA9554PWR configurando los pines según PinState (bit=1 entrada, bit=0 salida)
void TCA9554PWR_Init(uint8_t PinState)
{                  
  Mode_EXIOS(PinState);      
}
