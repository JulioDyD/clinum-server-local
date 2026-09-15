# Clinum Local Server - Instalación

## Instalación Automática

### Linux
```bash
curl -fsSL https://raw.githubusercontent.com/JulioDyD/clinum-server-local/main/install-linux.sh | sudo bash
```

## Actualización

```bash
curl -fsSL https://raw.githubusercontent.com/JulioDyD/clinum-server-local/main/update-linux.sh | sudo bash
```

## Comandos Útiles

```bash
# Ver estado del servicio
systemctl status clinum-server

# Ver logs en tiempo real
journalctl -u clinum-server -f

# Reiniciar servicio
systemctl restart clinum-server

# Detener servicio
systemctl stop clinum-server

# Verificar funcionamiento
curl http://localhost:8081/health
```

## Configuración

El archivo de configuración está en: `/opt/clinum-server/.env`

Para editar configuración:
```bash
sudo nano /opt/clinum-server/.env
# Luego reiniciar el servicio
sudo systemctl restart clinum-server
```

## Puerto Serial

Si tu puerto serial no es `/dev/ttyUSB0`, edita el archivo `.env`:
```bash
SERIAL_PORT=/dev/ttyUSB1  # o el puerto que corresponda
```

## Firewall

El puerto 8081 se abre automáticamente durante la instalación.
Para verificar:
```bash
sudo ufw status
```