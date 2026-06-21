import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import schema from "./_schema.json" with { type: "json" };
import { SiriusMsgMalformedFrameError } from "./errors.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema(schema);

const requestValidator = ajv.getSchema(`${schema.$id}#/$defs/SiriusMsgServiceRequest`);
const responseValidator = ajv.getSchema(`${schema.$id}#/$defs/SiriusMsgServiceResponse`);

export function validateDefinition(definitionName: string, value: unknown): void {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${definitionName}`);
  if (!validator?.(value)) {
    throw new SiriusMsgMalformedFrameError(ajv.errorsText(validator?.errors));
  }
  assertSafeRowIDs(value);
}

export function validateRequest(value: unknown): void {
  if (!requestValidator?.(value)) {
    throw new SiriusMsgMalformedFrameError(ajv.errorsText(requestValidator?.errors));
  }
  assertSafeRowIDs(value);
}

export function validateResponse(value: unknown): void {
  if (!responseValidator?.(value)) {
    throw new SiriusMsgMalformedFrameError(ajv.errorsText(responseValidator?.errors));
  }
  assertSafeRowIDs(value);
}

export function assertSafeRowIDs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      assertSafeRowIDs(child);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "rowID" && typeof child === "number" && !Number.isSafeInteger(child)) {
      throw new SiriusMsgMalformedFrameError(`rowID exceeds Number.MAX_SAFE_INTEGER: ${child}`);
    }
    assertSafeRowIDs(child);
  }
}
