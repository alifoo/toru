import { unavailable } from './unavailable.js';
export const mkdtempSync = (..._args: unknown[]): string => unavailable('mkdtempSync');
export const writeFileSync = (..._args: unknown[]): void => unavailable('writeFileSync');
export const readFileSync = (..._args: unknown[]): never => unavailable('readFileSync');
export const existsSync = (..._args: unknown[]): boolean => false;
