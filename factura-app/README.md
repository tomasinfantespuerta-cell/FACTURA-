# App de facturación

Formulario web que genera una factura en PDF (usando tu Gotenberg) y la envía
a n8n para que este la mande por Gmail y la guarde en Google Drive.

## Cómo funciona

```
Persona rellena el formulario (index.html)
        ↓
server.js construye el HTML de la factura con esos datos
        ↓
server.js llama a Gotenberg → recibe el PDF
        ↓
server.js envía el PDF a tu Webhook de n8n
        ↓
n8n: Gmail (enviar al cliente) + Google Drive (guardar copia)
```

Ya NO necesitas los nodos "Editar campos" ni "Código en JavaScript" en n8n.
Se sustituyen por esta aplicación.

---

## Paso 1 — Subir esta app a Railway

1. Sube esta carpeta a un repositorio de GitHub (puedes arrastrar los archivos
   directamente en github.com si no usas git desde terminal).
2. En Railway, pulsa **New Project → Deploy from GitHub repo** y selecciona
   ese repositorio. Railway detecta que es Node.js automáticamente.
3. En la pestaña **Variables** del servicio, añade:
   - `GOTENBERG_URL` → la URL pública de tu Gotenberg (la misma que ya usabas
     en el nodo HTTP Request de n8n)
   - `N8N_WEBHOOK_URL` → la pondrás en el Paso 2, de momento déjala en blanco
4. Despliega. Railway te dará una URL pública, por ejemplo:
   `https://factura-app-production.up.railway.app`

Esa URL es la que abrirá quien vaya a rellenar el formulario.

---

## Paso 2 — Crear el Webhook en n8n

1. En tu workflow de n8n, borra los nodos "Editar campos" y "Código en
   JavaScript" (y el HTTP Request a Gotenberg, ya no hace falta, la app lo
   hace por ti). También puedes desactivar el Form Trigger, ya no se usa
   (el formulario ahora vive en la app).
2. Añade un nodo **Webhook**:
   - Método: `POST`
   - Path: por ejemplo `factura-generada`
   - Modo de respuesta: "Immediately"
3. Al guardar, n8n te da la URL del webhook (algo como
   `https://primary-production-a7be7.up.railway.app/webhook/factura-generada`).
   Cópiala.
4. Vuelve a Railway, pega esa URL en la variable `N8N_WEBHOOK_URL` de la app,
   y redespliega (Railway lo hace solo al guardar la variable).

El Webhook recibirá, en cada ejecución:
- `pdf` → el archivo PDF de la factura (como binario)
- `correoCliente` → el email al que hay que enviarlo
- `nombreCliente` → nombre del cliente
- `numeroFactura` → número de factura

---

## Paso 3 — Nodo de Gmail

1. Después del Webhook, añade un nodo **Gmail → Send Email**.
2. Conecta tu cuenta de Gmail (credenciales OAuth, unos clics).
3. Campo **To**: usa una expresión `{{ $json.correoCliente }}`
4. Asunto y cuerpo: el texto que quieras, puedes usar
   `{{ $json.nombreCliente }}` y `{{ $json.numeroFactura }}` para
   personalizarlo.
5. En **Attachments**, selecciona la propiedad binaria `pdf` (así se adjunta
   la factura).

---

## Paso 4 — Nodo de Google Drive

1. Añade un nodo **Google Drive → Upload File**, conectado también al
   Webhook (en paralelo al de Gmail, o después de Gmail, como prefieras).
2. Conecta tu cuenta de Google Drive.
3. Selecciona la carpeta de la empresa donde quieres guardar las facturas.
4. En el campo del archivo a subir, selecciona la propiedad binaria `pdf`.
5. Nombre del archivo, por ejemplo: `Factura {{ $json.numeroFactura }}.pdf`

---

## Probarlo todo junto

1. Abre la URL pública de tu app (la de Railway del Paso 1).
2. Rellena el formulario con datos de prueba y pulsa "Generar y enviar
   factura".
3. Deberías ver "✓ Factura generada y enviada correctamente."
4. Revisa en n8n el historial de ejecuciones del Webhook — debería aparecer
   una ejecución exitosa, con el email enviado y el archivo en Drive.

Si algo falla, el mensaje de error que aparece en el formulario te dirá si el
problema está en Gotenberg (paso de generar el PDF) o en n8n (paso de
enviarlo), lo que ya reduce mucho dónde mirar.
