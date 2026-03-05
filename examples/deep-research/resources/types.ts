export interface Resource { name: string; content: string }

export interface Chunk {
  resource: string;
  heading: string;
  text: string;
  tokens: number[];
  startLine: number;
  endLine: number;
}
