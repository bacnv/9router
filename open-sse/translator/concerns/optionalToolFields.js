function toolSchema(tool) {
  const fn = tool?.function;
  return {
    name: tool?.name || fn?.name,
    schema: tool?.input_schema || tool?.parameters || fn?.parameters,
  };
}

function allowsNull(property) {
  const type = property?.type;
  return type === "null" || (Array.isArray(type) && type.includes("null")) ||
    property?.anyOf?.some((item) => item?.type === "null");
}

export function makeOptionalToolFieldsNullable(schema) {
  if (!schema?.properties) return schema;
  const required = new Set(schema.required || []);
  const properties = { ...schema.properties };

  for (const [name, property] of Object.entries(properties)) {
    if (required.has(name) || !property?.type || allowsNull(property)) continue;
    const type = Array.isArray(property.type) ? property.type : [property.type];
    properties[name] = {
      ...property,
      type: [...type.filter(Boolean), "null"],
      ...(Array.isArray(property.enum) && !property.enum.includes(null)
        ? { enum: [...property.enum, null] }
        : {}),
    };
  }

  return { ...schema, properties };
}

export function collectOptionalToolFields(body) {
  const result = new Map();
  for (const tool of body?.tools || []) {
    const { name, schema } = toolSchema(tool);
    if (!name || !schema?.properties) continue;
    const required = new Set(schema.required || []);
    const optional = new Set(
      Object.entries(schema.properties)
        .filter(([field, property]) => !required.has(field) && !allowsNull(property))
        .map(([field]) => field),
    );
    if (optional.size) result.set(name, optional);
  }
  return result;
}

export function removeNullOptionalToolFields(toolName, argumentsText, optionalToolFields) {
  const optional = optionalToolFields?.get(toolName);
  if (!optional || !argumentsText) return argumentsText;
  try {
    const args = JSON.parse(argumentsText);
    for (const field of optional) {
      if (args[field] === null) delete args[field];
    }
    return JSON.stringify(args);
  } catch {
    return argumentsText;
  }
}
