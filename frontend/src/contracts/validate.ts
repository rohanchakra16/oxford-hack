/**
 * Runtime validation against the generated JSON Schema bundle (the same schema the backend's
 * pydantic models produce). Structural rules only: cross-field rules (e.g. "segmentId set iff
 * playing") are enforced by the backend and documented in contracts/README.md.
 * Owner: Person 5.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import schema from './generated/schema.json';
import { MESSAGE_TYPES, SCHEMA_VERSION, type MessageType, type WireMessage } from './generated/types';

export type ValidationCode = 'invalid_json' | 'schema_version_mismatch' | 'unknown_type' | 'invalid_message';

export class ContractValidationError extends Error {
  constructor(
    readonly code: ValidationCode,
    message: string,
    readonly messageId: string | null = null,
  ) {
    super(message);
  }
}

const ajv = new Ajv2020({ allErrors: false, strict: false });
ajv.addSchema(schema, 'bundle');
const validators = new Map<string, ValidateFunction>();
const messageRefs = (schema as unknown as { 'x-messages': Record<string, { $ref: string }> })['x-messages'];

function validatorFor(type: MessageType): ValidateFunction {
  let v = validators.get(type);
  if (!v) {
    const ref = messageRefs[type]!.$ref; // "#/$defs/Name"
    v = ajv.compile({ $ref: `bundle${ref}` });
    validators.set(type, v);
  }
  return v;
}

const KNOWN = new Set<string>(MESSAGE_TYPES);

/** Validate a decoded value. Throws ContractValidationError with a readable, value-free message. */
export function validateMessage(value: unknown): WireMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractValidationError('invalid_message', 'message must be a JSON object');
  }
  const obj = value as Record<string, unknown>;
  const messageId = typeof obj.messageId === 'string' ? obj.messageId : null;
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractValidationError(
      'schema_version_mismatch',
      `received schemaVersion ${JSON.stringify(obj.schemaVersion)}; this client supports exactly '${SCHEMA_VERSION}'`,
      messageId,
    );
  }
  if (typeof obj.type !== 'string' || !KNOWN.has(obj.type)) {
    throw new ContractValidationError('unknown_type', `unknown message type ${JSON.stringify(obj.type)}`, messageId);
  }
  const validate = validatorFor(obj.type as MessageType);
  if (!validate(value)) {
    const e = validate.errors?.[0];
    const where = e?.instancePath || '<root>';
    throw new ContractValidationError('invalid_message', `${obj.type}: ${where} ${e?.message ?? 'invalid'}`, messageId);
  }
  return value as WireMessage;
}

/** Parse and validate wire text. JSON.parse already rejects NaN/Infinity tokens. */
export function parseMessage(text: string): WireMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ContractValidationError('invalid_json', 'not valid JSON');
  }
  return validateMessage(value);
}

export { SCHEMA_VERSION };
