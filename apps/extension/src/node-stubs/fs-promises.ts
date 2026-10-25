import { unavailable } from './unavailable.js';
export const mkdtemp = async (..._args: unknown[]): Promise<string> => unavailable('mkdtemp');
export const readFile = async (..._args: unknown[]): Promise<never> => unavailable('readFile');
export const writeFile = async (..._args: unknown[]): Promise<never> => unavailable('writeFile');
export const rm = async (..._args: unknown[]): Promise<void> => undefined;
