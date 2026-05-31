declare module 'dotenv' {
  interface DotenvConfigOptions {
    path?: string;
    encoding?: string;
    debug?: boolean;
    override?: boolean;
    processEnv?: NodeJS.ProcessEnv;
  }

  interface DotenvConfigOutput {
    error?: Error;
    parsed?: {
      [key: string]: string;
    };
  }

  interface DotenvModule {
    config(options?: DotenvConfigOptions): DotenvConfigOutput;
  }

  const dotenv: DotenvModule;
  export default dotenv;
}

