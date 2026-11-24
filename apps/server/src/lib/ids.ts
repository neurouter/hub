import { uuidv7 } from 'uuidv7';

/** Time-ordered UUIDv7 string (backend §4.1: ids are generated in the app). */
export function newId(): string {
  return uuidv7();
}
