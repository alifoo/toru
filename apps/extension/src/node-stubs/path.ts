export const join = (...parts: string[]): string => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const dirname = (path: string): string => path.replace(/\/[^/]*$/, '') || '/';
export const basename = (path: string): string => path.replace(/^.*\//, '');
