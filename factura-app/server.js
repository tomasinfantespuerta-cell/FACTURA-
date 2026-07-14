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

// Gotenberg es compartido por todos los clientes (no guarda datos de nadie)
const GOTENBERG_URL = process.env.GOTENBERG_URL;

const clientsPath = path.join(__dirname, 'clients.json');
const viewsDir = path.join(__dirname, 'views');
const defaultTemplatePath = path.join(viewsDir, 'invoice-template.html');

function getClients() {
  return JSON.parse(fs.readFileSync(clientsPath, 'utf-8'));
}

function getClient(slug) {
  return getClients().find((c) => c.slug === slug);
}

// Cliente "por defecto" = el primero de la lista (para que la URL raíz
// "/" siga funcionando como antes, sin romper nada de lo que ya había)
function getDefaultClient() {
  const clientes = getClients();
  return clientes[0];
}

function templatePathFor(cliente) {
  const nombreArchivo = cliente?.template || 'invoice-template.html';
  const ruta = path.join(viewsDir, nombreArchivo);
  return fs.existsSync(ruta) ? ruta : defaultTemplatePath;
}

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

function buildInvoiceHtml(data, rutaPlantilla) {
  let html = fs.readFileSync(rutaPlantilla, 'utf-8');

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

async function generarYEnviarFactura(cliente, data) {
  const faltantes = CAMPOS_REQUERIDOS.filter((campo) => !data[campo]);
  if (faltantes.length > 0) {
    const error = new Error(`Faltan campos obligatorios: ${faltantes.join(', ')}`);
    error.status = 400;
    throw error;
  }

  if (!Array.isArray(data.items) || data.items.length === 0) {
    const error = new Error('La factura necesita al menos un concepto.');
    error.status = 400;
    throw error;
  }

  if (!GOTENBERG_URL || !cliente.webhookUrl) {
    const error = new Error(
      'Falta GOTENBERG_URL (variable de entorno) o el webhookUrl de este cliente en clients.json.'
    );
    error.status = 500;
    throw error;
  }

  const html = buildInvoiceHtml(data, templatePathFor(cliente));

  // 1. Convertir el HTML a PDF usando Gotenberg (compartido por todos)
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

  // 2. Enviar el PDF al webhook de n8n propio de ESTE cliente
  const n8nForm = new FormData();
  n8nForm.append('pdf', pdfBuffer, {
    filename: `factura-${data.numeroFactura}.pdf`,
    contentType: 'application/pdf',
  });
  n8nForm.append('correoCliente', data.correoCliente);
  n8nForm.append('nombreCliente', data.nombreCliente);
  n8nForm.append('numeroFactura', data.numeroFactura);

  const n8nResponse = await fetch(cliente.webhookUrl, {
    method: 'POST',
    body: n8nForm,
    headers: n8nForm.getHeaders(),
  });

  if (!n8nResponse.ok) {
    const errText = await n8nResponse.text();
    throw new Error(`n8n respondió ${n8nResponse.status}: ${errText}`);
  }
}

// --- Rutas ---

// Formulario en la raíz "/" -> usa el cliente por defecto (compatibilidad
// con la URL de siempre, no rompe nada de lo ya montado)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/generar-factura', async (req, res) => {
  try {
    const cliente = getDefaultClient();
    await generarYEnviarFactura(cliente, req.body);
    res.json({ ok: true, mensaje: 'Factura generada y enviada correctamente.' });
  } catch (err) {
    console.error('Error generando la factura:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Formulario por cliente: "/panaderia-luna", "/estudio-alba", etc.
app.get('/:slug', (req, res, next) => {
  const cliente = getClient(req.params.slug);
  if (!cliente) return next(); // no existe ese cliente -> sigue a 404
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/:slug/generar-factura', async (req, res) => {
  try {
    const cliente = getClient(req.params.slug);
    if (!cliente) {
      return res.status(404).json({ error: `No existe ningún cliente con la ruta "${req.params.slug}".` });
    }
    await generarYEnviarFactura(cliente, req.body);
    res.json({ ok: true, mensaje: 'Factura generada y enviada correctamente.' });
  } catch (err) {
    console.error('Error generando la factura:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/salud', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de facturación escuchando en el puerto ${PORT}`);
});
