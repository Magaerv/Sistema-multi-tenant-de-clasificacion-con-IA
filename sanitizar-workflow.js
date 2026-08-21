#!/usr/bin/env node
/**
 * Sanitiza una exportación de n8n antes de compartirla.
 *
 * Uso:
 *   node sanitizar-workflow.js entrada.json salida.json
 *
 * Reemplaza los patrones sensibles conocidos por marcadores y verifica que
 * el resultado siga siendo JSON válido. No sustituye la revisión manual del
 * archivo resultante: cubre lo que sabe buscar, no lo que no previó.
 *
 * En un sistema multi-tenant el riesgo principal no son las credenciales
 * —n8n no las exporta— sino los identificadores: el documento de
 * configuración de tenants es la puerta de entrada a los datos de todos
 * los clientes, y su id aparece escrito dentro de un nodo.
 */

const fs = require('fs');

const REGLAS = [
  // Identificadores de documentos de Google (planillas, carpetas): 25-60
  // caracteres del alfabeto de ids, delimitados por comilla o barra.
  { nombre: 'ID de documento', patron: /\b[A-Za-z0-9_-]{25,60}\b(?=["'\/])/g, reemplazo: '<DOCUMENT_ID>' },

  // Identificadores internos de n8n: credenciales, workflows y nodos
  // referenciados por id. Cadenas de exactamente 16 caracteres.
  { nombre: 'ID de n8n', patron: /"id"\s*:\s*"[A-Za-z0-9]{16}"/g, reemplazo: '"id": "<N8N_ID>"' },

  // Rutas de webhook propias.
  { nombre: 'Ruta de webhook', patron: /"path"\s*:\s*"[^"]+"/g, reemplazo: '"path": "<WEBHOOK_PATH>"' },

  // Nombres de instancia de mensajería: identifican al cliente.
  { nombre: 'Instancia', patron: /"(instance|instanceName|instancia)"\s*:\s*"[^"]+"/g, reemplazo: '"$1": "<INSTANCE>"' },

  // Tokens tipo JWT (API keys de n8n, tokens OAuth).
  { nombre: 'JWT', patron: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, reemplazo: '<JWT>' },

  // Claves de proveedores conocidos.
  { nombre: 'Clave de proveedor', patron: /\b(sk-|sk-ant-|xoxb-|ghp_|AIza)[A-Za-z0-9_-]{10,}\b/g, reemplazo: '<PROVIDER_KEY>' },

  // Claves de API con prefijo propio.
  { nombre: 'API key', patron: /\b[a-z]{2,6}_\d{4}_[A-Za-z0-9]{6,}\b/g, reemplazo: '<API_KEY>' },

  // Correos electrónicos.
  { nombre: 'Correo', patron: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, reemplazo: '<EMAIL>' },

  // Teléfonos en formato internacional.
  { nombre: 'Teléfono', patron: /\b(?:\+|54)9?\d{9,13}\b/g, reemplazo: '<PHONE>' },

  // URLs propias. Se preservan las de documentación pública.
  //
  // La barra invertida queda excluida del conjunto a propósito: dentro de
  // un nodo de código, una URL puede aparecer seguida de una comilla
  // escapada (\"). Sin esa exclusión el reemplazo se lleva la barra de
  // escape y deja el JSON inválido.
  { nombre: 'URL', patron: /https?:\/\/(?!n8n\.io|docs\.|github\.com)[^\s"'<>\\]+/g, reemplazo: '<URL>' },
];

const [, , entrada, salida] = process.argv;

if (!entrada || !salida) {
  console.error('Uso: node sanitizar-workflow.js <entrada.json> <salida.json>');
  process.exit(1);
}

let texto = fs.readFileSync(entrada, 'utf8');
const conteo = {};

for (const { nombre, patron, reemplazo } of REGLAS) {
  const coincidencias = texto.match(patron);
  if (coincidencias) {
    conteo[nombre] = coincidencias.length;
    texto = texto.replace(patron, reemplazo);
  }
}

// Verificación de sintaxis: un reemplazo mal delimitado puede romper el
// escapado de una cadena. Si eso pasa, no se escribe nada.
try {
  JSON.parse(texto);
} catch (e) {
  console.error('El resultado no es JSON válido. Revisá las reglas de reemplazo.');
  console.error(e.message);
  process.exit(1);
}

fs.writeFileSync(salida, texto);

console.log(`Sanitizado: ${entrada} → ${salida}`);
if (Object.keys(conteo).length === 0) {
  console.log('No se encontraron patrones sensibles conocidos.');
} else {
  for (const [nombre, n] of Object.entries(conteo)) {
    console.log(`  ${nombre}: ${n} reemplazo(s)`);
  }
}
console.log('\nRevisá el archivo resultante a mano antes de compartirlo.');
