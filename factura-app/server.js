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
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function euros(numero) {
  return Number(numero || 0).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Construye las filas <tr> de la tabla de conceptos a partir del array "items"
function filasConceptos(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<tr><td colspan="4" style="color:#8A8F97">Sin conceptos</td></tr>';
  }
  return items
    .map((item) => {
      const cantidad = Number(item.cantidad) || 0;
      const precio = Number(item.precio) || 0;
      const importe = cantidad * precio;
      return `<tr>
        <td>${escapeHtml(item.concepto)}</td>
        <td class="num qty">${cantidad}</td>
        <td class="num price">${euros(precio)} €</td>
        <td class="num amount">${euros(importe)} €</td>
      </tr>`;
    })
    .join('\n');
}

function calcularTotales(items, ivaPorcentaje, irpfPorcentaje) {
  const baseImponible = (items || []).reduce((suma, item) => {
    const cantidad = Number(item.cantidad) || 0;
    const precio = Number(item.precio) || 0;
    return suma + cantidad * precio;
  }, 0);

  const cuotaIva = baseImponible * (Number(ivaPorcentaje) || 0) / 100;
  const retencionIrpf = baseImponible * (Number(irpfPorcentaje) || 0) / 100;
  const total = baseImponible + cuotaIva - retencionIrpf;

  return { baseImponible, cuotaIva, retencionIrpf, total };
}

function formatearFecha(fechaISO) {
  if (!fechaISO) return '';
  const [anio, mes, dia] = String(fechaISO).split('-');
  if (!anio || !mes || !dia) return fechaISO;
  return `${dia}/${mes}/${anio}`;
}

function buildInvoiceHtml(data) {
  let html = fs.readFileSync(templatePath, 'utf-8');

  const items = Array.isArray(data.items) ? data.items : [];
  const { baseImponible, cuotaIva, retencionIrpf, total } = calcularTotales(
    items,
    data.ivaPorcentaje,
    data.irpfPorcentaje
  );

  // Filas opcionales: solo aparecen si hay dato que mostrar
  const filaTelefono = data.telefono
    ? `<span class="field-label">Teléfono</span>${escapeHtml(data.telefono)}`
    : '';

  const filaFormaPago = data.formaPago
    ? `<div class="row"><span class="label">Forma de pago</span><span>${escapeHtml(data.formaPago)}</span></div>`
    : '';

  const filaNifCliente = data.nifCliente
    ? `<span class="field-label">NIF</span>${escapeHtml(data.nifCliente)}`
    : '';

  const filaDireccionCliente = data.direccionCliente
    ? `<span class="field-label">Dirección</span>${escapeHtml(data.direccionCliente)}`
    : '';

  const irpfPorcentaje = Number(data.irpfPorcentaje) || 0;
  const filaIrpf = irpfPorcentaje > 0
    ? `<div class="line deduccion"><span>Retención IRPF (${irpfPorcentaje}%)</span><span>-${euros(retencionIrpf)} €</span></div>`
    : '';

  const filaIban = data.iban
    ? `<div style="margin-top:6px">IBAN: ${escapeHtml(data.iban)}</div>`
    : '';

  const replacements = {
    '{{NOMBRE}}': data.nombre,
    '{{DIRECCION}}': data.direccion,
    '{{CORREO}}': data.correoElectronico,
    '{{NIF}}': data.nif,
    '{{FILA_TELEFONO}}': filaTelefono,

    '{{NOMBRE_CLIENTE}}': data.nombreCliente,
    '{{FILA_NIF_CLIENTE}}': filaNifCliente,
    '{{FILA_DIRECCION_CLIENTE}}': filaDireccionCliente,

    '{{NUMERO_FACTURA}}': data.numeroFactura,
    '{{FECHA_EMISION}}': formatearFecha(data.fechaEmision),
    '{{FILA_FORMA_PAGO}}': filaFormaPago,

    '{{FILAS_CONCEPTOS}}': filasConceptos(items),

    '{{BASE_IMPONIBLE}}': euros(baseImponible),
    '{{IVA_PORCENTAJE}}': Number(data.ivaPorcentaje) || 0,
    '{{CUOTA_IVA}}': euros(cuotaIva),
    '{{FILA_IRPF}}': filaIrpf,
    '{{TOTAL}}': euros(total),

    '{{FORMA_PAGO_TEXTO}}': escapeHtml(data.formaPago || 'No especificada'),
    '{{FILA_IBAN}}': filaIban,
    '{{NOTAS}}': escapeHtml(data.notas || '—'),
  };

  for (const [token, value] of Object.entries(replacements)) {
    // Los valores que ya son HTML (filas condicionales) no se escapan dos veces
    const esHtmlPrecalculado = String(token).startsWith('{{FILA') || token === '{{FILAS_CONCEPTOS}}';
    const valorFinal = esHtmlPrecalculado ? String(value ?? '') : escapeHtml(value);
    html = html.split(token).join(valorFinal);
  }
  return html;
}

// Campos obligatorios que debe traer el formulario
const CAMPOS_REQUERIDOS = [
  'nombre', 'nif', 'direccion', 'correoElectronico',
  'nombreCliente', 'correoCliente',
  'numeroFactura', 'fechaEmision',
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

    if (!Array.isArray(data.items) || data.items.length === 0) {
      return res.status(400).json({
        error: 'La factura necesita al menos un concepto.',
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
    n8nForm.append('correoCliente', data.correoCliente);
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
