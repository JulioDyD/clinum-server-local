# Secretos cifrados

Este directorio contiene la credencial de Firebase **cifrada** con age y la
llave privada compartida para descifrarla:

- `firebase-service-account.json.age`: credencial cifrada.
- `age.key`: llave privada compartida (se guarda en el repo por simplicidad).

> **Importante:** al estar la llave en el mismo repo, cualquiera con acceso al
> repositorio puede descifrar la credencial. Usa un repositorio **privado** con
> 2FA y acceso limitado. Si la llave se filtra, rota la credencial y la llave.

## Generar la credencial cifrada

En Linux/WSL, con `age` instalado:

```bash
cd clinum-web-local/local-server
bash packaging/encrypt-secret.sh \
  --service-account /root/clinum-sa.json \
  --init
```

El script:
- Genera la llave privada compartida en `secrets/age.key` (0600).
- Cifra la credencial en `secrets/firebase-service-account.json.age`.
- Imprime la clave pública.

Luego commitea ambos archivos:

```bash
git add clinum-web-local/local-server/secrets/age.key \
        clinum-web-local/local-server/secrets/firebase-service-account.json.age
git commit -m "chore: credencial Firebase cifrada y llave age"
```

## Instalación y actualización

El instalador/actualizador usa automáticamente `secrets/age.key` del repo:

```bash
sudo bash .../site-install.sh --ref vX.Y.Z --require-credential --yes
sudo clinum-update --ref vX.Y.Z --yes
```

No hace falta copiar la llave a cada sede ni pasar `--age-key-file`.

## Rotación

1. Generar una nueva credencial en Firebase Console.
2. Re-cifrar con la misma clave pública:
   ```bash
   bash packaging/encrypt-secret.sh \
     --service-account /root/clinum-sa-nueva.json \
     --public-key <CLAVE_PUBLICA>
   ```
3. Commit del `.age`.
4. `clinum-update --ref vX.Y.Z --yes`.
5. Revocar la credencial anterior.

Si se rota la llave age, hay que re-cifrar la credencial, commitear la nueva
`secrets/age.key` y actualizar todas las sedes.
