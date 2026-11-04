# Secretos cifrados

Este directorio contiene la credencial de Firebase **cifrada** con age:

- `firebase-service-account.json.age`: credencial cifrada, se commitea.
- Nunca subir el JSON en texto plano.

## Generar la credencial cifrada

En Linux/WSL, con `age` instalado:

```bash
bash packaging/encrypt-secret.sh \
  --service-account /root/clinum-sa.json \
  --init --key-out /root/clinum-age.key
```

El script:
- Genera la llave privada compartida en `/root/clinum-age.key` (0600).
- Cifra la credencial en `secrets/firebase-service-account.json.age`.
- Imprime la clave pública y la ruta de la llave privada.

Luego:
1. Commitea `secrets/firebase-service-account.json.age`.
2. Entrega `/root/clinum-age.key` a cada sede en `/root/clinum-age.key` (0600).
3. Instala/actualiza con `--age-key-file /root/clinum-age.key`.

La llave privada **no** se commitea.
