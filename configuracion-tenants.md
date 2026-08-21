# Tabla de configuración de tenants

Es la pieza que hace multi-tenant al sistema. Un único workflow atiende a todos los clientes porque todo lo que varía entre uno y otro vive acá, y se resuelve en tiempo de ejecución.

Está implementada como una hoja de cálculo externa. Nada de lo que sigue está escrito dentro del workflow.

---

## Campos

| Campo | Uso |
|---|---|
| `api_key` | Clave del cliente para el canal de formulario. Llega en la cabecera `x-api-key` y es la clave de búsqueda de ese canal |
| `instancia` | Nombre de la instancia de mensajería del cliente. Es la clave de búsqueda del canal de WhatsApp, y el destino al que se envían las respuestas |
| `nombre_negocio` | Nombre con el que el asistente se presenta |
| `rubro` | Sector del cliente, inyectado en el mensaje de sistema del clasificador |
| `oferta` | Descripción de lo que el cliente vende, inyectada en el mensaje de sistema |
| `tono` | Registro de las respuestas generadas |
| `sheet_id` | Identificador del documento donde se registran los leads de ese cliente |

---

## Cómo se usa cada campo

**Como clave de búsqueda.** `api_key` e `instancia` son los dos puntos de entrada. Según el canal detectado en la normalización, el sistema busca la fila por uno o por otro. Una búsqueda sin coincidencia devuelve una fila vacía, y la capa de validación corta con `401`.

**Como contexto del modelo.** `nombre_negocio`, `rubro`, `oferta` y `tono` se combinan en el mensaje de sistema del agente clasificador. Son la razón por la que el mismo prompt produce respuestas apropiadas para negocios distintos sin que el flujo cambie.

**Como destino de datos.** `sheet_id` se resuelve en el nodo de persistencia. El identificador del documento no está fijo: se toma de este campo en cada ejecución.

---

## Alta de un cliente

Agregar una fila. El workflow no se toca.

En la práctica el alta implica además tres cosas fuera de la tabla:

1. Crear el documento de destino y darle acceso a la cuenta que opera el sistema.
2. Crear la instancia de mensajería del cliente y registrar la URL del webhook.
3. Entregar la `api_key` a quien vaya a integrar el formulario web.

---

## Lo que esta tabla no resuelve

**No contiene credenciales de acceso a los datos del cliente.** Contiene el *destino*, no la *autorización*. Las escrituras se hacen con la credencial OAuth de la cuenta que opera el sistema. Ver el apartado de alcance del aislamiento en el [`README`](README.md#alcance-del-aislamiento) y la decisión D6 en [`decisiones-tecnicas.md`](decisiones-tecnicas.md).

**No define categorías por cliente.** El conjunto de clasificación es fijo para todos los tenants. Lo que varía es el contexto de negocio y el tono, no las categorías.

---

## Consideración de seguridad

Esta tabla es la puerta de entrada a los datos de todos los clientes: contiene las claves de API y los identificadores de todos los destinos.

Dos consecuencias prácticas:

- El acceso al documento debe estar restringido a la cuenta que opera el sistema.
- Su identificador aparece dentro del workflow. Es la razón principal por la que una exportación de n8n no se comparte sin sanitizar.
