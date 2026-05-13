declare module 'esl' {
  // Minimal typings to satisfy TypeScript
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  export type FreeSwitchCall = {
    api: (cmd: string) => Promise<string | unknown>;
    exit?: () => Promise<void> | void;
    on?: (event: string, handler: (...args: any[]) => void) => void;
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  export type FreeSwitchClient = {
    connect: () => Promise<void>;
    end: () => Promise<void>;
    on?: (event: string, handler: (...args: any[]) => void) => void;
  } & (new (...args: any[]) => any);

  export const FreeSwitchClient: {
    new (opts: { host?: string; port?: number; password?: string }): FreeSwitchClient;
  };

  export function once<T = any>(emitter: any, event: string): Promise<[T]>;
}


