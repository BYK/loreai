import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    loreTestRoot: string;
  }
}
