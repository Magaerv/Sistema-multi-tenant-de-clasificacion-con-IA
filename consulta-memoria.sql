-- Recuperación de la ventana de historial conversacional.
--
-- El sistema no mantiene una tabla propia de conversaciones: consulta
-- directamente el almacén de mensajes de Evolution API, que ya persiste
-- todo el tráfico de WhatsApp. Ver la decisión D3 en decisiones-tecnicas.md.
--
-- Devuelve los últimos 10 mensajes de un contacto dentro de una instancia.
-- El filtro por instancia es lo que impide que la ventana cruce entre
-- clientes: dos tenants distintos nunca comparten instancia.

SELECT
    key->>'fromMe'        AS from_me,
    message->>'conversation' AS texto,
    "messageTimestamp",
    "pushName"
FROM "Message"
WHERE
    key->>'remoteJid' = $1
    AND "instanceId" = (
        SELECT id
        FROM "Instance"
        WHERE name = $2
        LIMIT 1
    )
    AND message->>'conversation' IS NOT NULL
ORDER BY "messageTimestamp" DESC
LIMIT 10;

-- $1 → identificador de conversación del contacto (remoteJid)
-- $2 → nombre de la instancia de mensajería del tenant
--
-- Los dos valores se pasan como parámetros de consulta, no interpolados
-- en el texto del SQL. Ambos provienen del cuerpo de un webhook externo,
-- de modo que interpolarlos como cadena dejaría el sistema expuesto a
-- inyección a través de un campo que no controlamos.

-- ---------------------------------------------------------------------
-- Notas sobre el esquema consultado
--
-- "Message"  y  "Instance"  son tablas de Evolution API, no de este
-- sistema. Se leen; nunca se escriben. Las comillas dobles son necesarias
-- porque los identificadores están en camelCase.
--
-- El contenido del mensaje vive dentro de columnas JSON:
--   key      → metadatos de la conversación (remoteJid, fromMe)
--   message  → cuerpo del mensaje (conversation, para texto plano)
--
-- La condición sobre message->>'conversation' descarta los mensajes que
-- no son de texto plano — imágenes, audios, ubicaciones — que no aportan
-- al contexto del clasificador y llegarían como valor nulo.
--
-- Dependencia conocida: una actualización de Evolution API que renombre
-- estas tablas o reestructure los campos JSON rompe esta consulta.
-- Verificar antes de actualizar.
-- ---------------------------------------------------------------------
