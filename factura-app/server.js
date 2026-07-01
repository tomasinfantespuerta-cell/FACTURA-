import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Estas dos URLs se configuran como variables de entorno (ver .env.example)
const GOTENBERG_URL = process.env.GOTENBERG_URL;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

const templatePath = path.join(__dirname, 'views', 'invoice-template.html');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildInvoiceHtml(data) {
  let html = fs.readFileSync(templatePath, 'utf-8');

  const hoy = new Date().toLocaleDateString('es-ES');

  const replacements = {
    '{{NOMBRE}}': data.nombre,
    '{{DIRECCION}}': data.direccion,
    '{{CORREO}}': data.correoElectronico,
    '{{NIF}}': data.nif,
    '{{NOMBRE_CLIENTE}}': data.nombreCliente,
    '{{FECHA_EMISION}}': data.fechaEmision,
    '{{NUMERO_FACTURA}}': data.numeroFactura,
    '{{ENVIADO_EN}}': data.enviadoEn || hoy,
    '{{IMPORTE}}': data.importe,
    '{{MODO_FORMULARIO}}': data.modoFormulario || 'Pendiente',
  };

  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(escapeHtml(value ?? ''));
  }
  return html;
}

// Campos obligatorios que debe traer el formulario
const CAMPOS_REQUERIDOS = [
  'nombre', 'nombreCliente', 'direccion', 'correoElectronico',
  'nif', 'fechaEmision', 'numeroFactura', 'importe',
];

app.post('/generar-factura', async (req, res) => {
  try {
    const data = req.body;

    const faltantes = CAMPOS_REQUERIDOS.filter((campo) => !data[campo]);
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: `Faltan campos obligatorios: ${faltantes.join(', ')}`,
      });
    }

    if (!GOTENBERG_URL || !N8N_WEBHOOK_URL) {
      return res.status(500).json({
        error: 'Faltan las variables de entorno GOTENBERG_URL o N8N_WEBHOOK_URL en el servidor.',
      });
    }

    const html = buildInvoiceHtml(data);

    // 1. Convertir el HTML a PDF usando Gotenberg
    const gotenbergForm = new FormData();
    gotenbergForm.append('files', Buffer.from(html, 'utf-8'), {
      filename: 'index.html',
      contentType: 'text/html',
    });

    const gotenbergResponse = await fetch(
      `${GOTENBERG_URL}/forms/chromium/convert/html`,
      { method: 'POST', body: gotenbergForm, headers: gotenbergForm.getHeaders() }
    );

    if (!gotenbergResponse.ok) {
      const errText = await gotenbergResponse.text();
      throw new Error(`Gotenberg respondió ${gotenbergResponse.status}: ${errText}`);
    }

    const pdfBuffer = Buffer.from(await gotenbergResponse.arrayBuffer());

    // 2. Enviar el PDF ya generado a n8n, junto con los datos necesarios
    const n8nForm = new FormData();
    n8nForm.append('pdf', pdfBuffer, {
      filename: `factura-${data.numeroFactura}.pdf`,
      contentType: 'application/pdf',
    });
    n8nForm.append('correoCliente', data.correoElectronico);
    n8nForm.append('nombreCliente', data.nombreCliente);
    n8nForm.append('numeroFactura', data.numeroFactura);

    const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      body: n8nForm,
      headers: n8nForm.getHeaders(),
    });

    if (!n8nResponse.ok) {
      const errText = await n8nResponse.text();
      throw new Error(`n8n respondió ${n8nResponse.status}: ${errText}`);
    }

    res.json({ ok: true, mensaje: 'Factura generada y enviada correctamente.' });
  } catch (err) {
    console.error('Error generando la factura:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/salud', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de facturación escuchando en el puerto ${PORT}`);
});
