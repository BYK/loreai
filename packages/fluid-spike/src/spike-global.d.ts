interface Window {
  spike: {
    create(): Promise<string>;
    load(documentId: string): Promise<void>;
    share(documentId: string, participant: string): Promise<void>;
    append(author: string, text: string, at?: number): unknown;
    observations(): Array<{ text: string; seen: number }>;
    finalState(): unknown[];
    ready(): Promise<void>;
    dispose(): void;
  };
}
