# Arquitectura

Descripción capa por capa del flujo. Los nombres de identificadores reales —planillas, credenciales, rutas de webhook, instancias— se omiten deliberadamente.

---

## Capa 1 — Entrada y normalización

Un único webhook `POST` recibe el tráfico de los dos canales. El primer nodo determina cuál es y produce una estructura común.

**Detección de canal.** Si el cuerpo trae el evento `messages.upsert`, la solicitud viene del webhook de Evolution API. Cualquier otro cuerpo se trata como envío de formulario web.

**Filtrado anti-loop.** En el canal de WhatsApp, los mensajes marcados como propios (`fromMe`) se descartan en la entrada. Sin esto, cada respuesta del sistema volvería a entrar como mensaje nuevo y generaría un ciclo infinito de respuestas.

**Normalización.** Ambos canales se reducen a los mismos campos: nombre, contacto, empresa, mensaje, más los metadatos de canal e instancia. Todo lo que sigue trabaja sobre esa estructura y no vuelve a preguntar de dónde vino la solicitud.

En el canal de WhatsApp, donde no hay campos de formulario, el nombre se toma del perfil público del contacto y el identificador de contacto se deriva del número de teléfono.

---

## Capa 2 — Resolución del tenant

La normalización deja definido con qué clave hay que buscar la configuración del cliente:

| Canal | Clave de búsqueda | Dónde viene |
|---|---|---|
| Formulario web | API key | Cabecera `x-api-key` |
| WhatsApp | Nombre de instancia | Cuerpo del webhook |

La búsqueda se hace contra la tabla de configuración externa, devolviendo la primera coincidencia. Los campos que aporta cada fila están documentados en [`configuracion-tenants.md`](configuracion-tenants.md).

Ningún valor de esa tabla está escrito dentro del workflow. Incorporar un cliente es agregar una fila.

---

## Capa 3 — Validación

Un nodo condicional verifica que la fila resuelta traiga una clave de API no vacía.

Si no la trae —porque la búsqueda no encontró coincidencia— la ejecución responde `HTTP 401` con un cuerpo JSON de error y termina ahí.

Esta capa está deliberadamente **antes** de cualquier invocación de modelo. Los tokens de LLM son el costo variable dominante del sistema; validar primero acota la superficie de abuso a una lectura de la tabla de configuración por solicitud.

---

## Capa 4 — Recuperación del historial

Se consulta la base PostgreSQL de Evolution API para recuperar los últimos **10** mensajes intercambiados con el contacto.

El filtro combina dos condiciones: el identificador de conversación **y** el identificador de instancia, resuelto por nombre desde la tabla de instancias. La ventana nunca cruza entre clientes, porque la instancia forma parte de la condición.

La consulta completa está en [`consulta-memoria.sql`](consulta-memoria.sql).

Un nodo posterior arma el historial en texto plano y expone una bandera que indica si existe conversación previa. Si no hay historial —caso típico del formulario web, y de todo primer contacto por WhatsApp— el prompt se construye sin esa sección.

**Limitación conocida:** esta capa depende del esquema interno de Evolution API. Es una dependencia explícita, no un descuido: ver la decisión D3 en [`decisiones-tecnicas.md`](decisiones-tecnicas.md).

---

## Capa 5 — Clasificación y generación

Un agente de IA recibe dos bloques:

- **Mensaje de sistema**, construido con los datos del tenant: nombre del negocio, rubro, oferta y tono de respuesta. Incluye dos restricciones explícitas — responder solo en JSON válido, y no inventar precios ni datos que no se hayan provisto.
- **Prompt**, con el historial (si existe) y el mensaje actual, pidiendo una salida JSON con tres campos: `clasificacion`, `razon` y `respuesta`.

Las categorías son fijas para todos los tenants: `CALIENTE` ante urgencia o interés concreto, `TIBIO` ante interés vago, `FRÍO` ante exploración o saludo. Lo que varía por cliente es el contexto de negocio y el tono, no el conjunto de categorías.

La clasificación y la respuesta se generan en **una sola invocación**. El modelo no decide primero y redacta después: devuelve las dos cosas en el mismo JSON, considerando el historial para ambas.

---

## Capa 6 — Resiliencia

Tres capas encadenadas, cada una cubriendo una falla distinta.

| Capa | Mecanismo | Cubre | Costo |
|---|---|---|---|
| 1 | Reintentos sobre el agente primario | Errores transitorios, rate limiting | Latencia adicional |
| 2 | Agente de respaldo con otro proveedor | Indisponibilidad del proveedor primario | Posible variación de calidad y costo |
| 3 | Respuesta determinística en código | Salida vacía o JSON no parseable | Respuesta genérica |

**Capa 1.** El agente primario tiene reintentos activados y está configurado para **continuar la ejecución ante error** en lugar de abortarla. Esto es lo que hace posible la capa siguiente: si el nodo abortara, no habría nada que desviar.

**Capa 2.** Un nodo condicional evalúa si la salida del agente primario trae un campo de error. Si lo trae, la ejecución se desvía a un segundo agente, idéntico en prompt y mensaje de sistema, conectado a un proveedor de LLM distinto. Un nodo posterior unifica la salida de ambas ramas en un campo común, de modo que lo que sigue no necesita saber cuál de los dos respondió.

**Capa 3.** El nodo de parseo asume que la salida puede estar mal formada. Extrae el fragmento JSON entre la primera llave de apertura y la última de cierre —lo que tolera texto adicional antes o después— y lo parsea dentro de un `try/catch`.

Si la salida está vacía, o si el parseo falla, devuelve un objeto construido en código: categoría `TIBIO`, una respuesta genérica de acuse de recibo, y el campo `razon` marcado para revisión manual. Cada campo del objeto final tiene además un valor por defecto, de modo que un JSON válido pero incompleto tampoco rompe nada aguas abajo.

**Criterio de diseño:** el sistema puede degradar la calidad de la respuesta, pero no puede perder un lead.

---

## Capa 7 — Persistencia

El registro se agrega a la planilla del cliente. El identificador del documento **no está fijo en el nodo**: se resuelve por ejecución desde el campo correspondiente de la configuración del tenant.

El mapeo de columnas es automático a partir de los campos de entrada, de modo que agregar un campo al registro no requiere reconfigurar el nodo.

**Alcance del aislamiento:** cada cliente tiene su propio destino, pero la escritura se realiza con una única credencial OAuth —la de la cuenta que opera el sistema—, no con una credencial por cliente. La separación es de destino, no de autorización. El operador conserva acceso a los datos de todos los clientes. Ver la sección correspondiente del [`README`](README.md#alcance-del-aislamiento).

---

## Capa 8 — Respuesta

Un nodo de ruteo deriva según la categoría asignada, con una rama por cada una de las tres, más una **salida de descarte** para cualquier valor fuera del conjunto.

Cada rama evalúa después el canal de origen:

- **WhatsApp:** la respuesta se envía por Evolution API mediante una llamada HTTP a la instancia del cliente, y el webhook recibe una confirmación.
- **Formulario web:** la respuesta se devuelve directamente en el cuerpo de la respuesta HTTP, que quedó abierta desde la entrada.

La salida de descarte tiene su propia respuesta. Sin ella, una categoría inesperada del modelo terminaría la ejecución sin contestar: el lead quedaría registrado en la planilla pero sin respuesta, que es la falla más silenciosa del sistema.
