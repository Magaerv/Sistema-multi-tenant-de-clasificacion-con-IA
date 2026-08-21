# Decisiones técnicas

Registro de decisiones de diseño, con las alternativas evaluadas y los costos aceptados.

---

## D1 — Configuración de tenants en tabla externa

**Alternativas evaluadas**

1. Un workflow por cliente.
2. Ramificación condicional dentro de un único workflow.
3. Resolución en tiempo de ejecución desde una tabla externa.

**Decisión:** opción 3.

**Motivo:** la opción 1 multiplica el mantenimiento por cada cliente — un cambio en la lógica de clasificación habría que replicarlo N veces. La opción 2 crece en complejidad con cada incorporación y obliga a editar un flujo en producción para dar de alta a alguien. La opción 3 mantiene el workflow constante: el alta es una fila.

**Costo aceptado:** una lectura adicional por ejecución, y un punto de falla más. Si la tabla de configuración no responde, no responde el sistema entero.

---

## D2 — Clave de resolución distinta según el canal

**Contexto:** el sistema atiende formulario web y WhatsApp con el mismo webhook, pero la identidad del cliente no llega igual en los dos casos. Un formulario puede enviar una cabecera con una clave; un mensaje de WhatsApp reenviado por Evolution API, no.

**Alternativas evaluadas**

1. Dos webhooks separados, uno por canal.
2. Un webhook único con normalización previa y clave de resolución variable.

**Decisión:** opción 2.

**Motivo:** la lógica de negocio —clasificar, responder, registrar— es idéntica para ambos canales. Separarlos en dos flujos habría duplicado esa lógica para resolver una diferencia que se agota en el primer nodo.

**Costo aceptado:** las dos claves no ofrecen la misma garantía de seguridad. La API key es un secreto; el nombre de instancia no lo es. Está documentado en el apartado de alcance del aislamiento del README, y es una asimetría real, no un descuido.

---

## D3 — Reutilizar el almacén de mensajes existente como capa de memoria

**Alternativas evaluadas**

| Estrategia | Costo | Qué se pierde |
|---|---|---|
| Tabla propia de conversaciones, escrita por el flujo | Una escritura por mensaje, más crecimiento y purga a cargo del sistema | Nada funcional, pero duplica datos que ya existen |
| Historial en la misma hoja de cálculo del cliente | Sin infraestructura adicional | Latencia alta y límites de la API en cada lectura |
| Consulta directa a la base de mensajes de Evolution API | Una lectura por ejecución | Acoplamiento al esquema de un tercero |

**Decisión:** opción 3.

**Motivo:** Evolution API ya persiste todos los mensajes de WhatsApp en PostgreSQL. Construir una tabla propia habría significado mantener una segunda copia de los mismos datos, con su propia lógica de escritura, su propio crecimiento y la posibilidad de desincronizarse de la fuente real. La consulta directa elimina esa clase entera de problemas.

**Costo aceptado:** el sistema queda acoplado al esquema interno de Evolution API. Si una actualización renombra tablas o cambia la estructura de los campos JSON, la consulta se rompe. Es una dependencia que hay que verificar antes de cada actualización de Evolution.

**Alcance:** la memoria funciona únicamente en el canal de WhatsApp. Los envíos por formulario se tratan siempre como primer contacto.

**Ventana elegida:** los últimos 10 mensajes. Costo predecible en tokens y suficiente para conversaciones cortas orientadas a una tarea concreta.

**Revisión pendiente:** si aparecen conversaciones largas o de seguimiento en el tiempo, corresponde reevaluar hacia una estrategia de resumen progresivo.

---

## D4 — Tres capas de resiliencia, no una

**Alternativas evaluadas**

1. Reintentos únicamente.
2. Reintentos más proveedor de respaldo.
3. Reintentos, proveedor de respaldo y respuesta determinística final.

**Decisión:** opción 3.

**Motivo:** cada capa cubre una falla que la anterior no cubre. Los reintentos resuelven errores transitorios y rate limiting, pero no sirven si el proveedor está caído. El proveedor de respaldo resuelve la caída, pero ninguno de los dos resuelve que el modelo devuelva un texto que no es JSON válido — que es una falla de formato, no de disponibilidad, y por lo tanto se reproduce en el reintento.

**Detalle de implementación:** el agente primario está configurado para continuar la ejecución ante error en lugar de abortarla. Sin eso, la capa 2 no existiría: un nodo que aborta no deja nada que desviar.

**Costo aceptado:** un segundo proveedor implica una credencial más, un costo por token distinto y la posibilidad de que la calidad de clasificación varíe según cuál de los dos respondió. Se acepta porque una clasificación distinta es un problema menor frente a un lead sin responder.

**Criterio:** el sistema puede degradar la calidad de la respuesta, pero no puede perder un lead. Una respuesta genérica es un resultado aceptable; un mensaje sin registrar, no.

---

## D5 — Salida explícita para lo no clasificado

El nodo de ruteo por categoría declara una salida de descarte, con su propia rama de respuesta, para cualquier valor fuera del conjunto esperado.

**Motivo:** el modelo puede devolver una categoría que no está en el conjunto — mal escrita, traducida, o inventada. Sin salida de descarte, esa ejecución terminaría sin responder: el lead quedaría guardado en la planilla pero sin contestar, y nada lo señalaría.

Es la falla más silenciosa posible del sistema, porque no genera error ni queda registrada como tal. Una rama de descarte la convierte en algo visible.

---

## D6 — Evolución pendiente: autorización por cliente

**Estado actual:** cada cliente escribe en su propia planilla, pero todas las escrituras se hacen con una única credencial OAuth, la de la cuenta que opera el sistema. El aislamiento es de destino, no de autorización, y depende de que la resolución del tenant sea correcta. Es una garantía de código.

**Objetivo:** que cada cliente autorice su propio almacenamiento, de modo que la credencial usada para escribir simplemente no alcance los datos de otro. Eso convierte el aislamiento en una garantía de infraestructura, y quita al operador el acceso a los datos de los clientes.

**Alternativas evaluadas para implementarlo**

| Opción | Cómo | Costo |
|---|---|---|
| Ruteo a un nodo por cliente, cada uno con su credencial | Un nodo de escritura por tenant, seleccionado por condición | Rompe D1: cada alta vuelve a editar el workflow |
| Sub-workflow por cliente | El flujo padre resuelve el tenant y delega en un sub-workflow con su credencial fija | El padre queda constante; el alta duplica un sub-workflow |
| Token gestionado por el sistema | Se almacena el token de refresco de cada cliente, se renueva por código y se usa en una llamada HTTP genérica | Workflow totalmente constante; obliga a gestionar cifrado, rotación y revocación |

**Sin decidir.** La segunda opción es la de mejor relación entre esfuerzo y garantía. La tercera es la única que mantiene intacta la premisa de D1 y la que corresponde si el número de clientes crece.

Hasta que esto se implemente, el alcance real del aislamiento está declarado explícitamente en el README. La afirmación que no corresponde hacer hoy es que el operador no tenga acceso a los datos de los clientes.
