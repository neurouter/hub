import { setupServer } from 'msw/node';
import { createContractHandlers, defaultFixtures } from '@/mocks/handlers';

/** Node MSW server with contract-generated handlers (tests override per case with server.use). */
export const server = setupServer(...createContractHandlers(defaultFixtures()));
