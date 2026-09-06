declare module '*.frag' {
  const mod: {
    code: string;
    map: { file: string; line: number }[];
    entry: string;
    kind: 'image' | 'buffer';
    params: import('./params/schema.ts').ParamSpec[];
    buffers: import('./params/schema.ts').BufferBinding[];
  };
  export default mod;
}

declare module 'virtual:pa-resolve' {
  const mod: {
    code: string;
    map: { file: string; line: number }[];
    entry: string;
    kind: 'image';
    params: never[];
    buffers: never[];
  };
  export default mod;
}
