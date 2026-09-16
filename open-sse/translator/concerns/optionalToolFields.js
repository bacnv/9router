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

export function collectToolSchemas(body) {
  const result = new Map();
  for (const tool of body?.tools || []) {
    const { name, schema } = toolSchema(tool);
    if (name && schema) result.set(name, schema);
  }
  return result;
}

function schemaType(schema) {
  const types = (Array.isArray(schema?.type) ? schema.type : [schema?.type])
    .filter((type) => type && type !== "null");
  return types.length === 1 ? types[0] : null;
}

function coerceValue(value, schema) {
  const type = schemaType(schema);
  if (type === "boolean" && typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number) && (type !== "integer" || Number.isInteger(number))) return number;
  }
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const result = { ...value };
    for (const [name, property] of Object.entries(schema.properties || {})) {
      if (name in result) result[name] = coerceValue(result[name], property);
    }
    return result;
  }
  if (type === "array" && Array.isArray(value)) {
    return value.map((item) => coerceValue(item, schema.items));
  }
  return value;
}

export function normalizeToolArgumentTypes(toolName, argumentsText, toolSchemas) {
  const schema = toolSchemas?.get(toolName);
  if (!schema || !argumentsText) return argumentsText;
  try {
    return JSON.stringify(coerceValue(JSON.parse(argumentsText), schema));
  } catch {
    return argumentsText;
  }
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
