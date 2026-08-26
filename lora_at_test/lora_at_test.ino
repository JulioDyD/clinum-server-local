// Diagnostico RYLR998 — passthrough AT (pines probados: UART header 43/44)
// TX: GPIO43 (UART header TXD) -> RXD del modulo
// RX: GPIO44 (UART header RXD) <- TXD del modulo
// Envia AT automaticamente cada 3s y deja escribir comandos manuales.

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== LoRa AT test (TX=43, RX=44) — AT automatico cada 3s ===");
  Serial1.begin(115200, SERIAL_8N1, 44, 43); // RX=44, TX=43
  delay(300);
  Serial1.setTimeout(2000);
}

unsigned long lastAt = 0;

void loop() {
  if (millis() - lastAt > 3000) {
    lastAt = millis();
    Serial1.print("AT\r\n");
    Serial.println(">> AT (auto)");
  }
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;
    Serial1.print(cmd);
    Serial1.print("\r\n");
    Serial.println(">> " + cmd);
  }
  if (Serial1.available()) {
    String r = Serial1.readStringUntil('\n');
    r.trim();
    if (r.length() > 0) Serial.println("<< " + r);
  }
}