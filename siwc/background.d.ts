export interface SiwcBackgroundOptions {
  appName: string;
  pages: readonly string[];
  ruleId?: number;
  redirectPort?: number;
}

export declare function registerSiwcBackground(options: SiwcBackgroundOptions): void;
