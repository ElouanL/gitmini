export type MessageParams = Record<string, string | number>;
export type Messages = Record<string, string>;

const dict: Messages = {};

/** Adding strings (last written wins). A duplicate is reported in development. */
export function registerMessages(messages: Messages, source = 'runtime'): void {
  for (const [k, v] of Object.entries(messages)) {
    if (import.meta.env.DEV && k in dict && dict[k] !== v) {
      console.warn(`[i18n] key "${k}" redefined by ${source}`);
    }
    dict[k] = v;
  }
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Interpolate named parameters. Unknown keys remain visible for diagnosis. */
export function t(key: string, params?: MessageParams): string {
  const v = dict[key];
  if (v === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key "${key}"`);
    return key;
  }
  return interpolate(v, params);
}

/** English plural: singular for 1 and -1, plural otherwise. `{n}` is added to the parameters. */
export function tp(key: string, n: number, params?: MessageParams): string {
  const form = n === 1 || n === -1 ? 'one' : 'other';
  const k = `${key}.${form}`;
  return t(k in dict ? k : key, { n, ...params });
}

export function hasMessage(key: string): boolean {
  return key in dict;
}

/** List registered keys for consistency checks. */
export function messageKeys(): string[] {
  return Object.keys(dict);
}

// Production and tests load the same English catalog.
const modules = import.meta.glob<Messages>('./*.en.ts', { eager: true, import: 'default' });
for (const [path, messages] of Object.entries(modules)) registerMessages(messages, path);
